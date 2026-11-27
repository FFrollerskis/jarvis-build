import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../scripts/program-index.ts";
import { evidenceWeaknesses, EVIDENCE_WEAKNESSES, parseEvidenceDetails, parseEvidenceFacts, type EvidenceFacts } from "../src/program/evidence-header.ts";
import { isInsideRoot, loadProgramData, makeFileReader } from "../src/program/fs-loader.ts";
import { cleanReason, recordGate, type RecordGateInput } from "../src/program/gate-recorder.ts";
import { evaluateGate, gateWeaknesses, makeGateContext, type Gate, type GateContext } from "../src/program/gates.ts";
import { contractFingerprint, normalizeLineEndings, sha256Hex } from "../src/program/hash.ts";
import { formatReport, runProgramIndex } from "../src/program/run.ts";
import { EVIDENCE_AT, EVIDENCE_SHA, realEvidence } from "./program-index-evidence.ts";
import { A_TS, json, miniRepo, put, tmp } from "./program-index-minirepo.ts";

/**
 * WP-PGA fiks 1: M2 (PASS mot svak eller feilet evidens), M3 (kontrakt-staleness uten `fingerprint --write`) og L1 (begrunnelsen: retningstegn og direkte bruk av kommandolinjen).
 * Evidensfilene lages med den EKTE skriveren (`renderEvidence`), så lesingen av toppteksten testes mot det opptakeren faktisk skriver. Reviewerens prober (R01, R02, R04b, R14, R16, R17, R06b, R09a)
 * er flyttet hit som varige tester med syntetiske fiksturer; hver feiler uten sin fiks (se mutantsettet i rapporten).
 */
const NOW = "2026-11-26T14:00:00.000Z";
const SHA_HEAD = "b".repeat(40);
const GATE_OPEN_ALL = { OPEN: 17, PASS: 0, FAIL: 0 };

const rec = (root: string, over: Partial<RecordGateInput> = {}) =>
  recordGate({ root, gate_id: "G01", status: "PASS", evidence_path: "docs/evidence/e1.md", reason: "bevist i testen", by: "owner", now: NOW, git_sha: SHA_HEAD, write: false, ...over });
const problem = (r: ReturnType<typeof rec>): string => (r.ok ? "ok" : r.problem);
const withEvidence = (text: string = realEvidence()) => {
  const m = miniRepo();
  put(m.root, "docs/evidence/e1.md", text);
  return m;
};
const readGate = (root: string, id: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, "config/program", id.startsWith("ORL") ? "orl" : "gates", `${id}.json`), "utf8")) as Record<string, unknown>;
const run = (root: string) => runProgramIndex({ root, env: undefined, origin: [] });
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

/** Skriver en PASS-port DIREKTE (uten opptakeren), slik en hånd-redigering ville gjort: sha256 og øyeblikksbilde regnes riktig, så kun evidensens innhold avgjør styrken. */
function forgePass(root: string, id: string, evidencePath: string, over: { verified_at?: string; external?: boolean } = {}): void {
  const isOrl = id.startsWith("ORL");
  const text = readFileSync(join(root, evidencePath), "utf8");
  const alpha = loadProgramData(root).components.find((c) => c.component_id === "core.alpha");
  const ev = {
    path: evidencePath,
    sha256: sha256Hex(normalizeLineEndings(text)),
    git_sha: EVIDENCE_SHA,
    recorded_at: NOW,
    verified_at: over.verified_at ?? EVIDENCE_AT,
    verified_at_source: "evidence_header",
    contract_fingerprints: isOrl ? {} : { "core.alpha": alpha?.contract.fingerprint ?? null }
  };
  const base = readGate(root, id);
  put(
    root,
    `config/program/${isOrl ? "orl" : "gates"}/${id}.json`,
    json({
      ...base,
      ...(over.external === undefined ? {} : { external: over.external }),
      status: "PASS",
      evidence_ref: ev,
      history: [{ gate_kind: isOrl ? "orl" : "program_gate", gate_id: id, prior_status: "OPEN", new_status: "PASS", evidence_refs: [ev], owner: "owner", changed_at: NOW, reason: "forfalsket i testen" }]
    })
  );
}

describe("parseEvidenceDetails mot den ekte opptakeren", () => {
  it("exit-kode: rent tall (0 og ≠ 0), drept av tidsavbrudd eller signal", () => {
    expect(parseEvidenceDetails(realEvidence({ code: 0 }))).toMatchObject({ exit_kind: "code", exit_code: 0, from_stdin: false });
    expect(parseEvidenceDetails(realEvidence({ code: 1 }))).toMatchObject({ exit_kind: "code", exit_code: 1, from_stdin: false });
    expect(parseEvidenceDetails(realEvidence({ code: 127 }))).toMatchObject({ exit_kind: "code", exit_code: 127 });
    expect(parseEvidenceDetails(realEvidence({ code: 143, timedOut: true }))).toMatchObject({ exit_kind: "abnormal", exit_code: 143 });
    expect(parseEvidenceDetails(realEvidence({ code: 137, signal: "SIGKILL" }))).toMatchObject({ exit_kind: "abnormal", exit_code: 137 });
  });

  it("--stdin: opptakeren kjørte ingenting, og exit-koden er ukjent", () => {
    const d = parseEvidenceDetails(realEvidence({ stdin: true }));
    expect(d).toMatchObject({ exit_kind: "stdin", exit_code: null, from_stdin: true });
  });

  it("uten Exit-linje (hjemmelaget) = missing; flere Exit-linjer eller en ukjent form = unrecognized", () => {
    expect(parseEvidenceDetails("# Hjemmelaget\n\nalt ok\n").exit_kind).toBe("missing");
    expect(parseEvidenceDetails("- **Exit:** 0\n- **Exit:** 1\n\n## Utdata\n").exit_kind).toBe("unrecognized");
    expect(parseEvidenceDetails("- **Exit:** kanskje\n").exit_kind).toBe("unrecognized");
    expect(parseEvidenceDetails("- **Exit:** 0 men noe annet\n").exit_kind).toBe("unrecognized");
    expect(parseEvidenceDetails("- **Exit:** 1000\n").exit_kind).toBe("unrecognized");
    expect(parseEvidenceDetails("- **Exit:** -1\n").exit_kind).toBe("unrecognized");
  });

  it("kun toppsonen leses: en etterlignet Exit-linje i utdataene ER ikke exit-koden", () => {
    const failed = realEvidence({ code: 1, output: "- **Exit:** 0\n- **Kommando:** (lest fra stdin)\n- **Merknad:** ekstern-kilde: lurt" });
    expect(parseEvidenceDetails(failed)).toMatchObject({ exit_kind: "code", exit_code: 1, from_stdin: false, external_source: null });
  });

  it("en Kommando-linje som sier stdin teller som innlimt selv om Exit-linjen sier 0 (motsigelse = svak)", () => {
    const text = ["# E", "", "- **Kommando:** (lest fra stdin)", "- **Exit:** 0", "", "## Utdata", ""].join("\n");
    expect(parseEvidenceDetails(text)).toMatchObject({ exit_kind: "code", from_stdin: true });
  });

  it("ekstern-markør i Merknad-linjen: `ekstern-kilde:` og `eier-bekreftet:` (3-200 tegn), første Merknad-linje, forankret i begynnelsen", () => {
    expect(parseEvidenceDetails(realEvidence({ note: "ekstern-kilde: NAS-kjøring i testen" })).external_source).toBe("NAS-kjøring i testen");
    expect(parseEvidenceDetails(realEvidence({ note: "eier-bekreftet: gjennomgått" })).external_source).toBe("gjennomgått");
    expect(parseEvidenceDetails(realEvidence({ note: "ekstern-kilde: ab" })).external_source).toBeNull();
    expect(parseEvidenceDetails(realEvidence({ note: `ekstern-kilde: ${"x".repeat(200)}` })).external_source).toBe("x".repeat(200));
    expect(parseEvidenceDetails(realEvidence({ note: `ekstern-kilde: ${"x".repeat(201)}` })).external_source).toBeNull();
    expect(parseEvidenceDetails(realEvidence({ note: "tilfeldig ekstern-kilde: NAS" })).external_source).toBeNull();
    expect(parseEvidenceDetails(realEvidence({ note: "ekstern-kilde:NAS" })).external_source).toBeNull();
    expect(parseEvidenceDetails(realEvidence({})).external_source).toBeNull();
    expect(parseEvidenceDetails(realEvidence({ output: "- **Merknad:** ekstern-kilde: i utdataene" })).external_source).toBeNull();
  });

  it("parseEvidenceFacts er toppteksten pluss detaljene", () => {
    expect(parseEvidenceFacts(realEvidence({ note: "eier-bekreftet: ok greit" }))).toEqual({
      recorded_time: EVIDENCE_AT,
      git_sha: EVIDENCE_SHA,
      dirty: false,
      exit_kind: "code",
      exit_code: 0,
      from_stdin: false,
      external_source: "ok greit"
    });
  });
});

describe("evidenceWeaknesses: hver svakhet for seg, i fast rekkefølge", () => {
  const strong: EvidenceFacts = { recorded_time: EVIDENCE_AT, git_sha: EVIDENCE_SHA, dirty: false, exit_kind: "code", exit_code: 0, from_stdin: false, external_source: null };
  const ctx = { external: false, verified_at: EVIDENCE_AT };
  const w = (patch: Partial<EvidenceFacts>, c: Partial<typeof ctx> = {}) => evidenceWeaknesses({ ...strong, ...patch }, { ...ctx, ...c });

  it("sterk evidens gir ingen svakhet (også når verified_at er ELDRE enn toppteksten)", () => {
    expect(w({})).toEqual([]);
    expect(w({}, { verified_at: "2026-11-26T12:59:59.999Z" })).toEqual([]);
  });

  it("hver svakhet", () => {
    expect(w({ recorded_time: null })).toEqual(["header_time_missing"]);
    expect(w({}, { verified_at: "2026-11-26T13:00:00.001Z" })).toEqual(["verified_at_after_header"]);
    expect(w({ git_sha: null })).toEqual(["git_sha_missing"]);
    expect(w({ dirty: true })).toEqual(["dirty_tree"]);
    expect(w({ from_stdin: true, exit_kind: "stdin", exit_code: null })).toEqual(["from_stdin"]);
    expect(w({ exit_kind: "code", exit_code: 1 })).toEqual(["exit_not_zero"]);
    expect(w({ exit_kind: "abnormal", exit_code: 0 })).toEqual(["exit_not_zero"]);
    expect(w({ exit_kind: "missing", exit_code: null })).toEqual(["exit_unknown"]);
    expect(w({ exit_kind: "unrecognized", exit_code: null })).toEqual(["exit_unknown"]);
    expect(w({}, { external: true })).toEqual(["external_marker_missing"]);
    expect(w({ external_source: "NAS" }, { external: true })).toEqual([]);
  });

  it("flere svakheter samtidig, i fast rekkefølge; innlimt utdata gir ikke i tillegg exit-svakhet", () => {
    expect(w({ recorded_time: null, git_sha: null, dirty: true, exit_kind: "missing", exit_code: null }, { external: true })).toEqual(["header_time_missing", "git_sha_missing", "dirty_tree", "exit_unknown", "external_marker_missing"]);
    expect(w({ from_stdin: true, exit_kind: "code", exit_code: 3 })).toEqual(["from_stdin"]);
  });

  it("alle kodene har en forklaring (ingen død kode)", () => {
    expect(EVIDENCE_WEAKNESSES).toHaveLength(9);
    expect(new Set(EVIDENCE_WEAKNESSES).size).toBe(EVIDENCE_WEAKNESSES.length);
  });
});

describe("M2: PASS mot svak eller feilet evidens nektes (reviewerens R01, R02, R04b, R17)", () => {
  it("R01: evidens fra en kommando som AVSLUTTET med exit 1 gir ikke PASS (men FAIL går)", () => {
    const { root } = withEvidence(realEvidence({ code: 1 }));
    const r = rec(root);
    expect(problem(r)).toBe("evidence_exit_not_zero");
    expect(!r.ok && r.detail).toContain("exit 1");
    expect(problem(rec(root, { status: "FAIL" }))).toBe("ok");
  });

  it("en kommando som ble DREPET (tidsavbrudd eller signal) gir ikke PASS selv om koden skulle være 0", () => {
    for (const o of [{ code: 143, timedOut: true }, { code: 137, signal: "SIGKILL" }, { code: 0, timedOut: true }]) {
      const { root } = withEvidence(realEvidence(o));
      expect(problem(rec(root)), JSON.stringify(o)).toBe("evidence_exit_not_zero");
      expect(problem(rec(root, { status: "FAIL" })), JSON.stringify(o)).toBe("ok");
    }
  });

  it("R02: evidens pipet inn via --stdin (opptakeren kjørte ingenting) gir aldri PASS, men kan registreres som FAIL", () => {
    const { root } = withEvidence(realEvidence({ stdin: true }));
    expect(problem(rec(root))).toBe("evidence_from_stdin");
    expect(problem(rec(root, { status: "FAIL" }))).toBe("ok");
  });

  it("en hjemmelaget fil uten Exit-linje gir ikke PASS (kan ikke vise at noe lyktes); FAIL går", () => {
    const { root } = withEvidence(`# Hjemmelaget\n\n- **Tidspunkt (UTC):** ${EVIDENCE_AT}\n- **Git:** \`${EVIDENCE_SHA}\` på \`main\`\n\n## Utdata\n\nalt ok\n`);
    expect(problem(rec(root))).toBe("evidence_exit_unknown");
    expect(problem(rec(root, { status: "FAIL" }))).toBe("ok");
    put(root, "docs/evidence/e1.md", "# trust me\nall good\n");
    expect(problem(rec(root))).toBe("evidence_exit_unknown");
  });

  it("exit 0 fra en kjørt kommando godtas uten advarsel og uten svakheter", () => {
    const { root } = withEvidence();
    const r = rec(root);
    expect(r.ok && r.warnings).toEqual([]);
    expect(r.ok && r.weaknesses).toEqual([]);
  });

  it("R04b: --verified-at kan ikke gjøre evidensen nyere enn toppteksten (omgikk «evidens eldre enn kontraktendringen»)", () => {
    // Evidens tatt 6 dager FØR kontraktendringen (T0 = 2026-11-26T12:00): nektet uten flagget, og flagget kan ikke redde den.
    const old = "2026-11-20T09:00:00.000Z";
    const { root } = withEvidence(realEvidence({ at: old }));
    expect(problem(rec(root))).toBe("evidence_older_than_contract_change");
    const flagged = rec(root, { verified_at: NOW });
    expect(problem(flagged)).toBe("verified_at_after_evidence");
    expect(!flagged.ok && flagged.detail).toContain(old);
    // Også en flagg-verdi som er ETTER kontraktendringen men før registreringen er nektet; en tidligere verdi er tillatt (og blir da også foreldet).
    expect(problem(rec(root, { verified_at: "2026-11-26T12:30:00.000Z" }))).toBe("verified_at_after_evidence");
    expect(problem(rec(root, { verified_at: "2026-11-19T09:00:00.000Z" }))).toBe("evidence_older_than_contract_change");
  });

  it("--verified-at uten tidsangivelse i toppteksten har ingenting å begrenses mot og nektes", () => {
    const { root } = withEvidence(`# E\n\n- **Git:** \`${EVIDENCE_SHA}\` på \`main\`\n- **Exit:** 0\n\n## Utdata\n`);
    expect(problem(rec(root, { verified_at: "2026-11-26T13:00:00.000Z" }))).toBe("verified_at_after_evidence");
    expect(problem(rec(root))).toBe("ok");
  });

  it("R17: en external-port krever markør for ekstern kilde eller eier-bekreftelse i evidensen; FAIL og ikke-external porter er uberørt", () => {
    const { root } = withEvidence();
    const g = readGate(root, "G01");
    put(root, "config/program/gates/G01.json", json({ ...g, external: true }));
    const r = rec(root);
    expect(problem(r)).toBe("external_confirmation_required");
    expect(!r.ok && r.detail).toContain("selvrapportert");
    expect(problem(rec(root, { status: "FAIL" }))).toBe("ok");
    put(root, "docs/evidence/e1.md", realEvidence({ note: "ekstern-kilde: NAS-kjøring utført av eier" }));
    expect(problem(rec(root))).toBe("ok");
    put(root, "docs/evidence/e1.md", realEvidence({ note: "eier-bekreftet: signoff gitt i møte" }));
    expect(problem(rec(root))).toBe("ok");
    put(root, "docs/evidence/e1.md", realEvidence({ note: "bare en vanlig merknad" }));
    expect(problem(rec(root))).toBe("external_confirmation_required");
    put(root, "config/program/gates/G01.json", json({ ...g, external: false }));
    expect(problem(rec(root))).toBe("ok");
  });

  it("en external ORL krever det samme", () => {
    const { root } = withEvidence();
    const g = readGate(root, "ORL0");
    put(root, "config/program/orl/ORL0.json", json({ ...g, external: true }));
    expect(problem(rec(root, { gate_id: "ORL0" }))).toBe("external_confirmation_required");
    put(root, "docs/evidence/e1.md", realEvidence({ note: "eier-bekreftet: nivået er gjennomgått" }));
    expect(problem(rec(root, { gate_id: "ORL0" }))).toBe("ok");
  });

  it("en PASS med svakheter som likevel godtas (tidspunkt mangler, uren arbeidstre) meldes i `weaknesses` og som advarsel", () => {
    const { root } = withEvidence(realEvidence({ dirty: true }));
    const dirty = rec(root);
    expect(dirty.ok && dirty.weaknesses).toEqual(["dirty_tree"]);
    expect(dirty.ok && dirty.warnings.some((x) => x.includes("ucommittede"))).toBe(true);
    put(root, "docs/evidence/e1.md", `# E\n\n- **Git:** \`${EVIDENCE_SHA}\` på \`main\`\n- **Exit:** 0\n\n## Utdata\n`);
    const noTime = rec(root);
    expect(noTime.ok && noTime.weaknesses).toEqual(["header_time_missing"]);
    put(root, "docs/evidence/e1.md", `# E\n\n- **Tidspunkt (UTC):** ${EVIDENCE_AT}\n- **Exit:** 0\n\n## Utdata\n`);
    const noSha = rec(root);
    expect(noSha.ok && noSha.weaknesses).toEqual(["git_sha_missing"]);
    expect(rec(root, { status: "FAIL" }).ok && (rec(root, { status: "FAIL" }) as { weaknesses: string[] }).weaknesses).toEqual([]);
  });
});

describe("M2: skanningen flagger PASS uten sterk evidens (gate_weak_evidence), og rapporten viser styrken", () => {
  it("en vanlig registrert PASS er sterk: ingen funn, 1 sterk i rapporten, og etiketten `by` er merket som uautentisert", () => {
    const { root } = withEvidence();
    expect(rec(root, { write: true }).ok).toBe(true);
    const r = run(root);
    expect(r.findings).toEqual([]);
    expect(r.counts.gates_weak_evidence).toBe(0);
    expect(r.counts.orls_weak_evidence).toBe(0);
    const text = formatReport(r);
    expect(text).toContain("Evidens for PASS: 1 sterk, 0 svak");
    expect(text).toContain("ikke autentisert");
  });

  it("uten noen PASS er det ingen evidenslinje i rapporten", () => {
    const { root } = miniRepo();
    expect(formatReport(run(root))).not.toContain("Evidens for PASS");
  });

  it("R16: håndskrevet portfil + håndskrevet evidens ga før effektiv PASS med 0 funn; nå gate_weak_evidence (rød i enforce)", () => {
    const { root } = miniRepo();
    put(root, "docs/evidence/forged.md", "# anything at all\n");
    forgePass(root, "G01", "docs/evidence/forged.md");
    const r = run(root);
    expect(r.counts.gates_effective).toEqual({ OPEN: 16, PASS: 1, FAIL: 0 });
    expect(r.findings.map((f) => f.id)).toEqual(["gate_weak_evidence:G01"]);
    expect(r.findings[0]?.message).toContain("exit");
    expect(r.counts.gates_weak_evidence).toBe(1);
    expect(r.verdict.ok).toBe(true);
    expect(formatReport(r)).toContain("Evidens for PASS: 0 sterk, 1 svak");
    const strict = runProgramIndex({ root, env: "enforce", origin: [] });
    expect(strict.verdict.ok).toBe(false);
    expect(strict.verdict.failures.join(" ")).toContain("gate_weak_evidence:G01");
  });

  it("hver svakhet gir funnet når portfilen er forfalsket rundt en ekte (men svak) evidensfil", () => {
    const cases: Array<[string, string, string]> = [
      ["exit 1", realEvidence({ code: 1 }), "exit_not_zero"],
      ["drept", realEvidence({ code: 143, timedOut: true }), "exit_not_zero"],
      ["stdin", realEvidence({ stdin: true }), "from_stdin"],
      ["uren", realEvidence({ dirty: true }), "dirty_tree"],
      ["ukjent git-status", realEvidence({ dirty: null }), "dirty_tree"],
      ["uten exit", `# E\n\n- **Tidspunkt (UTC):** ${EVIDENCE_AT}\n- **Git:** \`${EVIDENCE_SHA}\` på \`main\`\n\n## Utdata\n`, "exit_unknown"],
      ["uten tidspunkt", `# E\n\n- **Git:** \`${EVIDENCE_SHA}\` på \`main\`\n- **Exit:** 0\n\n## Utdata\n`, "header_time_missing"],
      ["uten git-SHA", `# E\n\n- **Tidspunkt (UTC):** ${EVIDENCE_AT}\n- **Exit:** 0\n\n## Utdata\n`, "git_sha_missing"]
    ];
    for (const [label, text, expected] of cases) {
      const { root } = withEvidence(text);
      forgePass(root, "G01", "docs/evidence/e1.md");
      const r = run(root);
      expect(r.findings.map((f) => f.id), label).toEqual(["gate_weak_evidence:G01"]);
      expect(r.findings[0]?.message, label).toContain(expected === "exit_not_zero" ? "exit er ikke 0" : expected === "from_stdin" ? "--stdin" : expected === "dirty_tree" ? "ucommittede" : expected === "exit_unknown" ? "exit-linje" : expected === "header_time_missing" ? "tidsangivelse" : "git-SHA");
    }
  });

  it("verified_at senere enn toppteksten (forfalsket) er svak; en external-port uten markør er svak, og med markør er den sterk", () => {
    const { root } = withEvidence();
    forgePass(root, "G01", "docs/evidence/e1.md", { verified_at: "2026-11-26T13:30:00.000Z" });
    expect(run(root).findings.map((f) => f.id)).toEqual(["gate_weak_evidence:G01"]);
    forgePass(root, "G01", "docs/evidence/e1.md", { verified_at: EVIDENCE_AT, external: true });
    expect(run(root).findings.map((f) => f.id)).toEqual(["gate_weak_evidence:G01"]);
    put(root, "docs/evidence/e1.md", realEvidence({ note: "ekstern-kilde: NAS-kjøring" }));
    forgePass(root, "G01", "docs/evidence/e1.md", { external: true });
    expect(run(root).findings).toEqual([]);
  });

  it("et ORL-nivå med svak evidens telles som svakt nivå (ikke som port)", () => {
    const { root } = miniRepo();
    put(root, "docs/evidence/forged.md", "# anything\n");
    forgePass(root, "ORL0", "docs/evidence/forged.md");
    const r = run(root);
    expect(r.findings.map((f) => f.id)).toEqual(["gate_weak_evidence:ORL0"]);
    expect(r.counts).toMatchObject({ gates_weak_evidence: 0, orls_weak_evidence: 1 });
  });

  it("en PASS som er foreldet gir gate_stale og ikke også gate_weak_evidence; åpne porter gir aldri svak-funn", () => {
    const { root } = miniRepo();
    put(root, "docs/evidence/forged.md", "# anything\n");
    forgePass(root, "G01", "docs/evidence/forged.md");
    put(root, "contracts/a.ts", "export const a = 2;\n");
    expect(run(root).findings.map((f) => f.id)).toEqual(["contract_fingerprint_mismatch:core.alpha", "gate_stale:G01"]);
    expect(run(miniRepo().root).findings).toEqual([]);
  });

  it("gateWeaknesses: ingen evidens = ingen svakhet; en fil som ikke kan leses = evidence_unreadable", () => {
    const gate = { evidence_ref: null, external: false };
    const ctx: GateContext = { component: () => undefined, evidence_sha256: () => null, evidence_facts: () => null };
    expect(gateWeaknesses(gate, ctx)).toEqual([]);
    const ref = { path: "docs/evidence/x.md", sha256: "a".repeat(64), git_sha: EVIDENCE_SHA, recorded_at: NOW, verified_at: EVIDENCE_AT, verified_at_source: "evidence_header" as const, contract_fingerprints: {} };
    expect(gateWeaknesses({ evidence_ref: ref, external: false }, ctx)).toEqual(["evidence_unreadable"]);
  });
});

describe("M3: kontrakt-staleness uten `fingerprint --write` (reviewerens R14)", () => {
  const registered = () => {
    const m = withEvidence();
    expect(rec(m.root, { write: true }).ok).toBe(true);
    return m;
  };

  it("en kontraktfil endret ETTER registreringen åpner porten med en gang, selv om skjervens fingeravtrykk ikke er oppdatert", () => {
    const { root } = registered();
    expect(run(root).counts.gates_effective).toEqual({ OPEN: 16, PASS: 1, FAIL: 0 });
    put(root, "contracts/a.ts", `${A_TS}export const changed = 2;\n`);
    const r = run(root);
    expect(r.counts.gates_effective).toEqual(GATE_OPEN_ALL);
    expect(r.counts.gates_declared.PASS).toBe(1);
    expect(r.findings.map((f) => f.id)).toEqual(["contract_fingerprint_mismatch:core.alpha", "gate_stale:G01"]);
    expect(r.findings[1]?.message).toContain("stale_contract_files_changed:core.alpha");
  });

  it("filen tilbake til slik den var: porten er PASS igjen (live == øyeblikksbildet)", () => {
    const { root } = registered();
    put(root, "contracts/a.ts", "export const a = 2;\n");
    expect(run(root).counts.gates_effective.PASS).toBe(0);
    put(root, "contracts/a.ts", A_TS);
    const r = run(root);
    expect(r.counts.gates_effective.PASS).toBe(1);
    expect(r.findings).toEqual([]);
  });

  it("en kontraktfil som er slettet eller ikke kan leses betyr foreldet (ulesbar = stale)", () => {
    const { root } = registered();
    writeFileSync(join(root, "contracts/a.ts"), "");
    expect(run(root).counts.gates_effective.PASS).toBe(0);
    mkdirSync(join(root, "contracts/sub"), { recursive: true });
    const g = readGate(root, "G01");
    expect(g["status"]).toBe("PASS");
    put(root, "contracts/a.ts", A_TS);
    expect(run(root).counts.gates_effective.PASS).toBe(1);
    // Fingeravtrykket i skjerven er oppdatert men øyeblikksbildet er gammelt: foreldet som før (stale_fingerprint_changed).
    put(root, "contracts/a.ts", "export const a = 3;\n");
    expect(run(root).findings.map((f) => f.id)).toContain("gate_stale:G01");
  });

  it("gate_stale i enforce: den kontraktendrede porten er rød uten at noen har kjørt fingerprint --write", () => {
    const { root } = registered();
    put(root, "contracts/a.ts", "export const a = 2;\n");
    expect(runProgramIndex({ root, env: "enforce", origin: [] }).verdict.ok).toBe(false);
  });

  it("makeGateContext regner det LIVE fingeravtrykket: null uten kontraktfiler, `unreadable` når en fil mangler, ellers contractFingerprint; hver komponent hashes én gang", () => {
    const sha: Record<string, string | null> = { "a.ts": "1".repeat(64), "b.ts": "2".repeat(64), "gone.ts": null };
    const calls: string[] = [];
    const reader = { file_sha256: (p: string) => (calls.push(p), sha[p] ?? null), evidence_facts: () => null };
    const comp = (id: string, files: string[]) => ({ component_id: id, contract: { version: "0.1.0", schema_version: null, files, fingerprint: null, changed_at: null } });
    const ctx = makeGateContext([comp("x.none", []), comp("x.ok", ["b.ts", "a.ts"]), comp("x.gone", ["a.ts", "gone.ts"])], reader);
    expect(ctx.component("x.none")?.live_fingerprint).toBeNull();
    expect(ctx.component("x.ok")?.live_fingerprint).toBe(contractFingerprint([{ path: "a.ts", sha256: "1".repeat(64) }, { path: "b.ts", sha256: "2".repeat(64) }]));
    expect(ctx.component("x.gone")?.live_fingerprint).toBe("unreadable");
    expect(ctx.component("x.missing")).toBeUndefined();
    const before = calls.length;
    ctx.component("x.ok");
    ctx.component("x.gone");
    expect(calls.length).toBe(before);
  });

  it("evaluateGate: øyeblikksbildet mot det live fingeravtrykket (stale_contract_files_changed); uten live-verdi (hånd-bygd kontekst) som før", () => {
    const FP1 = `sha256:${"1".repeat(64)}`;
    const FP2 = `sha256:${"2".repeat(64)}`;
    const ref = { path: "docs/evidence/x.md", sha256: "a".repeat(64), git_sha: EVIDENCE_SHA, recorded_at: NOW, verified_at: EVIDENCE_AT, verified_at_source: "evidence_header" as const, contract_fingerprints: { "core.alpha": FP1 } };
    const gate: Pick<Gate, "status" | "evidence_ref" | "bound_components" | "external"> = { status: "PASS", evidence_ref: ref, bound_components: ["core.alpha"], external: false };
    const ctx = (live: string | null | undefined): GateContext => ({
      component: () => ({ contract_fingerprint: FP1, changed_at: "2026-11-01T00:00:00.000Z", ...(live === undefined ? {} : { live_fingerprint: live }) }),
      evidence_sha256: () => "a".repeat(64),
      evidence_facts: () => null
    });
    expect(evaluateGate(gate, ctx(FP1)).effective).toBe("PASS");
    expect(evaluateGate(gate, ctx(undefined)).effective).toBe("PASS");
    for (const live of [FP2, null, "unreadable"]) {
      const e = evaluateGate(gate, ctx(live));
      expect(e.effective, String(live)).toBe("OPEN");
      expect(e.reasons, String(live)).toEqual([{ code: "stale_contract_files_changed", component_id: "core.alpha" }]);
    }
  });
});

describe("realpath-inneholdelse: en symlenket MELLOMKATALOG kan ikke peke evidensen ut av repoet (R06b)", () => {
  it("isInsideRoot følger symlenker: innenfor, utenfor og ukjent sti", () => {
    const { root } = miniRepo();
    const outside = tmp();
    put(outside, "x.md", "x");
    mkdirSync(join(root, "docs"), { recursive: true });
    symlinkSync(outside, join(root, "docs/ut"));
    symlinkSync(join(root, "contracts"), join(root, "docs/inn"));
    expect(isInsideRoot(root, join(root, "contracts/a.ts"))).toBe(true);
    expect(isInsideRoot(root, join(root, "docs/inn/a.ts"))).toBe(true);
    expect(isInsideRoot(root, join(root, "docs/ut/x.md"))).toBe(false);
    expect(isInsideRoot(root, join(root, "finnes-ikke"))).toBe(false);
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it("et søskenkatalog som deler PREFIKS med rota (repo-evil ved siden av repo) er utenfor", () => {
    const base = tmp();
    mkdirSync(join(base, "repo"));
    mkdirSync(join(base, "repo-evil"));
    writeFileSync(join(base, "repo-evil", "x.md"), "x");
    writeFileSync(join(base, "repo", "y.md"), "y");
    expect(isInsideRoot(join(base, "repo"), join(base, "repo-evil", "x.md"))).toBe(false);
    expect(isInsideRoot(join(base, "repo"), join(base, "repo", "y.md"))).toBe(true);
  });

  it("registreringen nekter evidens i en symlenket katalog som peker utenfor repoet, men godtar en som peker innenfor", () => {
    const { root } = miniRepo();
    const outside = tmp();
    put(outside, "real.md", realEvidence());
    mkdirSync(join(root, "docs"), { recursive: true });
    symlinkSync(outside, join(root, "docs/evidence"));
    const r = rec(root, { evidence_path: "docs/evidence/real.md" });
    expect(problem(r)).toBe("evidence_not_regular_file");
    expect(!r.ok && r.detail).toContain("utenfor repoet");

    const m2 = miniRepo();
    put(m2.root, "lager/real.md", realEvidence());
    mkdirSync(join(m2.root, "docs"), { recursive: true });
    symlinkSync(join(m2.root, "lager"), join(m2.root, "docs/evidence"));
    expect(problem(rec(m2.root, { evidence_path: "docs/evidence/real.md" }))).toBe("ok");
  });

  it("filleseren (hash og topptekst) gir null for filer utenfor repoet via symlenket katalog", () => {
    const { root } = miniRepo();
    const outside = tmp();
    put(outside, "real.md", realEvidence());
    mkdirSync(join(root, "docs"), { recursive: true });
    symlinkSync(outside, join(root, "docs/evidence"));
    const reader = makeFileReader(root);
    expect(reader.file_sha256("docs/evidence/real.md")).toBeNull();
    expect(reader.evidence_facts("docs/evidence/real.md")).toBeNull();
    const ok = makeFileReader(withEvidence().root);
    expect(ok.evidence_facts("docs/evidence/e1.md")).toMatchObject({ exit_kind: "code", exit_code: 0 });
    expect(ok.evidence_facts("docs/evidence/finnes-ikke.md")).toBeNull();
    expect(ok.evidence_facts("../utenfor.md")).toBeNull();
  });
});

describe("L1: begrunnelsen (retningstegn, direkte bruk av kommandolinjen)", () => {
  const RLO = cp(0x202e);
  const LRI = cp(0x2066);
  const PDI = cp(0x2069);
  const fakeToken = () => ["gh", "p_"].join("") + "A1b2C3d4".repeat(5);

  it("cleanReason fjerner retningstegn (U+202A-202E og U+2066-2069), bredde-null-tegn og kontrolltegn; flettet linjeskift og eksotiske mellomrom blir vanlige mellomrom", () => {
    expect(cleanReason(`ok ${RLO}evil${cp(0x202c)} ferdig`)).toBe("ok evil ferdig");
    for (const c of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) expect(cleanReason(`a${cp(c)}b`), c.toString(16)).toBe("ab");
    for (const c of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0x00ad, 0x180e, 0x0000, 0x0007, 0x001b, 0x007f]) expect(cleanReason(`a${cp(c)}b`), c.toString(16)).toBe("ab");
    expect(cleanReason("a\r\n\nb")).toBe("a b");
    expect(cleanReason(`a${cp(0x2028)}b${cp(0x2029)}c`)).toBe("a b c");
    expect(cleanReason(`a${cp(0x00a0)}b${cp(0x3000)}c`)).toBe("a b c");
    expect(cleanReason("  trimmet  ")).toBe("trimmet");
    expect(cleanReason("Vanlig norsk tekst med æøå, og tegn: 1-2/3.")).toBe("Vanlig norsk tekst med æøå, og tegn: 1-2/3.");
  });

  it("recordGate lagrer begrunnelsen RENSET (ingen retningstegn i den committede filen); en begrunnelse av bare usynlige tegn er ugyldig", () => {
    const { root } = withEvidence();
    const r = rec(root, { reason: `bevist ${RLO}med${LRI} retningstegn${PDI}`, write: true });
    expect(r.ok && r.payload.reason).toBe("bevist med retningstegn");
    const stored = readFileSync(join(root, "config/program/gates/G01.json"), "utf8");
    for (const c of [0x202e, 0x2066, 0x2069]) expect(stored.includes(cp(c))).toBe(false);
    const m2 = withEvidence();
    expect(problem(rec(m2.root, { reason: `${RLO}${LRI}${PDI}${cp(0x200b)}  ` }))).toBe("reason_invalid");
    expect(problem(rec(m2.root, { reason: `a${RLO}b` }))).toBe("reason_invalid");
    expect(problem(rec(m2.root, { reason: `ab${RLO}c` }))).toBe("ok");
  });

  const cli = (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(args, {}, (l) => out.push(l), (l) => err.push(l));
    return { code, out, err };
  };
  const gateArgs = (root: string, reason: string, extra: string[] = []) => ["gate", "G01", "PASS", "--root", root, "--reason", reason, "--by", "owner", "--evidence", "docs/evidence/e1.md", ...extra];

  it("R09a: `program-index.ts gate` DIREKTE screener begrunnelsen som inngangen (hemmelighetsform og retningstegn nektes med exit 2, ingenting skrives, verdien gjengis aldri)", () => {
    const { root } = withEvidence();
    const secret = fakeToken();
    const a = cli(gateArgs(root, `bevist med ${secret} i kjøringen`, ["--write"]));
    expect(a.code).toBe(2);
    expect(a.err.join("\n")).toContain("reason_secret");
    expect(a.err.join("\n")).not.toContain(secret);
    expect(a.err.join("\n")).not.toContain("A1b2C3d4");
    const b = cli(gateArgs(root, `bevist ${RLO}snudd`, ["--write"]));
    expect(b.code).toBe(2);
    expect(b.err.join("\n")).toContain("retningstegn");
    const c = cli(gateArgs(root, `bevist ${LRI}isolert${PDI}`, ["--write"]));
    expect(c.code).toBe(2);
    expect(readGate(root, "G01")["status"]).toBe("OPEN");
    expect((readGate(root, "G01")["history"] as unknown[]).length).toBe(0);
  });

  it("en vanlig begrunnelse går gjennom direkte, og utskriften merker at `by` er en selvrapportert etikett", () => {
    const { root } = withEvidence();
    const r = cli(gateArgs(root, "bevist i testen", ["--write"]));
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("OPEN -> PASS");
    expect(r.out.join("\n")).toContain("--by owner er en selvrapportert rolle-etikett, ikke autentisert");
    expect(readGate(root, "G01")["status"]).toBe("PASS");
  });

  it("kommandolinjen: PASS mot feilet eller innlimt evidens nektes (exit 1); svak-merknad skrives ut når en svak PASS likevel godtas", () => {
    const failed = withEvidence(realEvidence({ code: 2 }));
    const f = cli(gateArgs(failed.root, "bevist i testen"));
    expect(f.code).toBe(1);
    expect(f.err.join("\n")).toContain("evidence_exit_not_zero");
    const stdin = withEvidence(realEvidence({ stdin: true }));
    expect(cli(gateArgs(stdin.root, "bevist i testen")).err.join("\n")).toContain("evidence_from_stdin");
    expect(cli(["gate", "G01", "FAIL", "--root", stdin.root, "--reason", "innlimt feil", "--by", "owner", "--evidence", "docs/evidence/e1.md"]).code).toBe(0);
    const dirty = withEvidence(realEvidence({ dirty: true }));
    const d = cli(gateArgs(dirty.root, "bevist i testen"));
    expect(d.code).toBe(0);
    expect(d.out.join("\n")).toContain("merk: svak evidens (dirty_tree)");
    expect(d.out.join("\n")).toContain("gate_weak_evidence");
  });
});
