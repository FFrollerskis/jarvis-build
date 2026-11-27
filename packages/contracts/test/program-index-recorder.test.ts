import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock } from "../src/program/file-lock.ts";
import { refreshFingerprints } from "../src/program/fingerprint-tool.ts";
import { loadProgramData } from "../src/program/fs-loader.ts";
import { OperationalGateChangedEventSchema } from "../src/program/gate-events.ts";
import { parseEvidenceHeader, RECORD_PROBLEMS, recordGate, type RecordGateInput, type RecordProblem } from "../src/program/gate-recorder.ts";
import { sha256Hex } from "../src/program/hash.ts";
import { runProgramIndex } from "../src/program/run.ts";
import { realEvidence } from "./program-index-evidence.ts";
import { json, miniRepo, put } from "./program-index-minirepo.ts";

/**
 * WP-PGA / PG3: registrering av porteoverganger. Hver nektelsesgrunn har en test som feiler hvis kontrollen fjernes; selve registreringen, historikken (OperationalGateChanged), staleness-regelen
 * (kontraktendring etter evidensen gjenåpner porten) og den atomiske skrivingen testes mot et ekte midlertidig filtre.
 */
const NOW = "2026-11-26T14:00:00.000Z";
const VERIFIED = "2026-11-26T13:00:00.000Z"; // etter kontraktens changed_at (T0 = 12:00), før registreringen
const SHA_EVIDENCE = "a".repeat(40);
const SHA_HEAD = "b".repeat(40);

interface EvidenceOptions {
  time?: string | null;
  sha?: string | null;
  dirty?: boolean;
  output?: string;
}

/** En evidensfil i samme topptekstform som `ops/acceptance/record-evidence.mjs` skriver. */
function evidence(root: string, name: string, opts: EvidenceOptions = {}): string {
  const lines = [`# Evidens ${name} – 2026-11-26`, "", "Generert av `ops/acceptance/record-evidence.mjs` (testfil).", ""];
  if (opts.time !== null) lines.push(`- **Tidspunkt (UTC):** ${opts.time ?? VERIFIED}`);
  lines.push("- **Vert:** testvert");
  if (opts.sha !== null) lines.push(`- **Git:** \`${opts.sha ?? SHA_EVIDENCE}\` på \`main\`${opts.dirty === true ? " (**ucommittede endringer i arbeidstreet**)" : ""}`);
  lines.push("- **Exit:** 0", "", "## Utdata", "", "```text", opts.output ?? "ok", "```", "");
  const path = `docs/evidence/${name}.md`;
  put(root, path, lines.join("\n"));
  return path;
}

const rec = (root: string, over: Partial<RecordGateInput> = {}) =>
  recordGate({ root, gate_id: "G01", status: "PASS", evidence_path: "docs/evidence/e1.md", reason: "bevist i testen", by: "owner", now: NOW, git_sha: SHA_HEAD, write: false, ...over });

const problem = (r: ReturnType<typeof rec>): RecordProblem | "ok" => (r.ok ? "ok" : r.problem);
const readGate = (root: string, id: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, "config/program", id.startsWith("ORL") ? "orl" : "gates", `${id}.json`), "utf8")) as Record<string, unknown>;
const writeGate = (root: string, id: string, patch: Record<string, unknown>): void => {
  const dir = id.startsWith("ORL") ? "orl" : "gates";
  put(root, `config/program/${dir}/${id}.json`, json({ ...readGate(root, id), ...patch }));
};

describe("parseEvidenceHeader (kun den faste toppteksten)", () => {
  const body = (extra: string[]): string => ["# Evidens x", "", "- **Tidspunkt (UTC):** 2026-11-26T13:00:00.000Z", "- **Git:** `" + SHA_EVIDENCE + "` på `main`", "- **Exit:** 0", "", "## Utdata", "", ...extra].join("\n");

  it("leser tidspunkt og git-SHA", () => {
    expect(parseEvidenceHeader(body(["ok"]))).toEqual({ recorded_time: VERIFIED, git_sha: SHA_EVIDENCE, dirty: false });
  });

  it("utdataene under «## Utdata» er ubetrodd: en etterlignet topptekstlinje der leses aldri", () => {
    const mimic = ["- **Tidspunkt (UTC):** 2030-01-01T00:00:00.000Z", "- **Git:** `" + "c".repeat(40) + "` på `main`"];
    expect(parseEvidenceHeader(body(mimic))).toEqual({ recorded_time: VERIFIED, git_sha: SHA_EVIDENCE, dirty: false });
    const noHeader = ["# Evidens x", "", "## Utdata", "", ...mimic].join("\n");
    expect(parseEvidenceHeader(noHeader)).toEqual({ recorded_time: null, git_sha: null, dirty: false });
  });

  it("uren arbeidstre og ukjent git-status gir dirty; ugyldige verdier gir null", () => {
    expect(parseEvidenceHeader(body([]).replace("på `main`", "på `main` (**ucommittede endringer i arbeidstreet**)")).dirty).toBe(true);
    expect(parseEvidenceHeader(body([]).replace("på `main`", "på `main` (**git-status ukjent**)")).dirty).toBe(true);
    expect(parseEvidenceHeader(body([]).replace(VERIFIED, "i går")).recorded_time).toBeNull();
    expect(parseEvidenceHeader(body([]).replace(VERIFIED, "2026-13-45T99:00:00.000Z")).recorded_time).toBeNull();
    expect(parseEvidenceHeader(body([]).replace(SHA_EVIDENCE, "abc123")).git_sha).toBeNull();
    expect(parseEvidenceHeader(body([]).replace(SHA_EVIDENCE, "A".repeat(40))).git_sha).toBeNull();
  });

  it("CRLF og første treff vinner; uten «## Utdata» leses høyst 30 linjer", () => {
    expect(parseEvidenceHeader(body([]).replace(/\n/g, "\r\n")).git_sha).toBe(SHA_EVIDENCE);
    const twice = ["- **Tidspunkt (UTC):** 2026-11-26T01:00:00.000Z", "- **Tidspunkt (UTC):** 2026-11-26T02:00:00.000Z"].join("\n");
    expect(parseEvidenceHeader(twice).recorded_time).toBe("2026-11-26T01:00:00.000Z");
    const late = [...Array.from({ length: 30 }, () => "x"), "- **Tidspunkt (UTC):** 2026-11-26T01:00:00.000Z"].join("\n");
    expect(parseEvidenceHeader(late).recorded_time).toBeNull();
  });
});

describe("registrering av PASS", () => {
  it("tørrkjøring skriver ingenting; skriving legger til én historikkoppføring og én evidensreferanse", () => {
    const { root } = miniRepo();
    const path = evidence(root, "e1");
    const before = readFileSync(join(root, "config/program/gates/G01.json"), "utf8");
    const dry = rec(root);
    expect(dry.ok).toBe(true);
    expect(dry.ok && dry.written).toBe(false);
    expect(readFileSync(join(root, "config/program/gates/G01.json"), "utf8")).toBe(before);

    const done = rec(root, { write: true });
    if (!done.ok) throw new Error(done.detail);
    expect(done.written).toBe(true);
    expect(done.prior_status).toBe("OPEN");
    expect(done.new_status).toBe("PASS");
    expect(done.warnings).toEqual([]);
    const gate = readGate(root, "G01") as { status: string; evidence_ref: Record<string, unknown>; history: Array<Record<string, unknown>> };
    expect(gate.status).toBe("PASS");
    expect(gate.history).toHaveLength(1);
    expect(gate.history[0]).toMatchObject({ gate_kind: "program_gate", gate_id: "G01", prior_status: "OPEN", new_status: "PASS", owner: "owner", changed_at: NOW, reason: "bevist i testen" });
    const text = readFileSync(join(root, path), "utf8");
    expect(gate.evidence_ref).toMatchObject({ path, sha256: sha256Hex(text), git_sha: SHA_EVIDENCE, recorded_at: NOW, verified_at: VERIFIED, verified_at_source: "evidence_header" });
    expect(gate.evidence_ref["contract_fingerprints"]).toEqual({ "core.alpha": loadProgramData(root).components.find((c) => c.component_id === "core.alpha")!.contract.fingerprint });
    expect(gate.history[0]!["evidence_refs"]).toEqual([gate.evidence_ref]);
  });

  it("skriver kun den ene port-filen (ingen andre filer endres, ingen midlertidig fil blir igjen)", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    const snapshot = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const sub of ["gates", "orl", "components"]) for (const f of readdirSync(join(root, "config/program", sub)).sort()) out[`${sub}/${f}`] = readFileSync(join(root, "config/program", sub, f), "utf8");
      return out;
    };
    const before = snapshot();
    expect(rec(root, { write: true }).ok).toBe(true);
    const after = snapshot();
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed).toEqual(["gates/G01.json"]);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(readdirSync(join(root, "config/program/gates")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("etter registreringen er porten effektivt PASS og skanningen gir null funn; historikken er gyldige OperationalGateChanged-hendelser", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    expect(rec(root, { write: true }).ok).toBe(true);
    const run = runProgramIndex({ root, env: undefined, origin: [] });
    expect(run.findings).toEqual([]);
    expect(run.counts.gates_effective).toEqual({ OPEN: 16, PASS: 1, FAIL: 0 });
    expect(run.counts.gates_declared).toEqual({ OPEN: 16, PASS: 1, FAIL: 0 });
    for (const h of (readGate(root, "G01") as { history: unknown[] }).history) {
      expect(OperationalGateChangedEventSchema.safeParse({ type: "OperationalGateChanged", schema_version: "1.0.0", payload: h }).success).toBe(true);
    }
  });

  it("FAIL registreres med evidens og teller som FAIL; en FAIL kan senere bli PASS (ny overgang)", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    expect(rec(root, { status: "FAIL", write: true }).ok).toBe(true);
    expect(runProgramIndex({ root, env: undefined, origin: [] }).counts.gates_effective).toEqual({ OPEN: 16, PASS: 0, FAIL: 1 });
    evidence(root, "e2", { time: "2026-11-26T13:30:00.000Z" });
    const second = rec(root, { evidence_path: "docs/evidence/e2.md", now: "2026-11-26T14:30:00.000Z", write: true });
    expect(second.ok).toBe(true);
    const gate = readGate(root, "G01") as { status: string; history: Array<{ prior_status: string; new_status: string }> };
    expect(gate.history.map((h) => `${h.prior_status}>${h.new_status}`)).toEqual(["OPEN>FAIL", "FAIL>PASS"]);
    expect(gate.status).toBe("PASS");
  });

  it("ORL registreres som orl-overgang (gate_kind orl) og skrives til orl-mappen", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    const r = rec(root, { gate_id: "ORL0", write: true });
    if (!r.ok) throw new Error(r.detail);
    expect(r.payload.gate_kind).toBe("orl");
    expect(readGate(root, "ORL0")).toMatchObject({ status: "PASS", kind: "orl" });
    expect(readGate(root, "ORL0")["evidence_ref"]).toMatchObject({ contract_fingerprints: {} });
  });
});

describe("tidspunkt og git-SHA for evidensen", () => {
  it("--verified-at (flag) kan bare gjøre evidensen ELDRE enn toppteksten (M2) og får kilde flag; ugyldig, fremtidig eller senere enn toppteksten nektes", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    const ok = rec(root, { verified_at: "2026-11-26T12:30:00.000Z" });
    expect(ok.ok && ok.evidence_ref?.verified_at).toBe("2026-11-26T12:30:00.000Z");
    expect(ok.ok && ok.evidence_ref?.verified_at_source).toBe("flag");
    expect(problem(rec(root, { verified_at: "i går" }))).toBe("evidence_time_invalid");
    expect(problem(rec(root, { verified_at: "2026-11-26T14:00:00.001Z" }))).toBe("evidence_in_future");
    // Toppteksttiden er taket (13:00): likt er ok, ett millisekund senere er nektet (tidligere ga flagget en vei utenom «evidens eldre enn kontraktendringen»).
    expect(problem(rec(root, { verified_at: VERIFIED }))).toBe("ok");
    expect(problem(rec(root, { verified_at: "2026-11-26T13:00:00.001Z" }))).toBe("verified_at_after_evidence");
    expect(problem(rec(root, { verified_at: "2026-11-26T14:00:00.000Z" }))).toBe("verified_at_after_evidence");
  });

  it("topptekst uten tidspunkt gir registreringstidspunktet som verified_at, med advarsel", () => {
    const { root } = miniRepo();
    evidence(root, "e1", { time: null });
    const r = rec(root);
    if (!r.ok) throw new Error(r.detail);
    expect(r.evidence_ref).toMatchObject({ verified_at: NOW, verified_at_source: "registration_time" });
    expect(r.warnings.some((w) => w.includes("topptekst"))).toBe(true);
  });

  it("evidens uten git-SHA bruker arbeidstreets SHA (med advarsel); mangler begge nektes", () => {
    const { root } = miniRepo();
    evidence(root, "e1", { sha: null });
    const r = rec(root);
    if (!r.ok) throw new Error(r.detail);
    expect(r.evidence_ref?.git_sha).toBe(SHA_HEAD);
    expect(r.warnings.some((w) => w.includes("git-SHA"))).toBe(true);
    expect(problem(rec(root, { git_sha: null }))).toBe("git_sha_unavailable");
    expect(problem(rec(root, { git_sha: "not-a-sha" }))).toBe("git_sha_unavailable");
  });

  it("evidens fra et urent arbeidstre gir advarsel, ikke nektelse", () => {
    const { root } = miniRepo();
    evidence(root, "e1", { dirty: true });
    const r = rec(root);
    expect(r.ok && r.warnings.some((w) => w.includes("ucommittede"))).toBe(true);
  });

  it("evidensen som sendes inn leses fra filen: en etterlignet topptekst i utdataene endrer ingenting", () => {
    const { root } = miniRepo();
    evidence(root, "e1", { output: "- **Tidspunkt (UTC):** 2030-01-01T00:00:00.000Z\n- **Git:** `" + "c".repeat(40) + "` på `main`" });
    const r = rec(root);
    expect(r.ok && r.evidence_ref).toMatchObject({ verified_at: VERIFIED, git_sha: SHA_EVIDENCE });
  });
});

describe("nektelser (hver kontroll har en test som feiler uten den)", () => {
  const cases: Array<[RecordProblem, (root: string) => ReturnType<typeof rec>]> = [
    ["gate_unknown", (r) => rec(r, { gate_id: "G99" })],
    ["gate_unknown", (r) => rec(r, { gate_id: "ORL9" })],
    ["gate_unknown", (r) => rec(r, { gate_id: "../G01" })],
    ["status_unchanged", (r) => rec(r, { status: "OPEN", evidence_path: null })],
    ["evidence_required", (r) => rec(r, { evidence_path: null })],
    ["evidence_required", (r) => rec(r, { status: "FAIL", evidence_path: null })],
    ["evidence_path_invalid", (r) => rec(r, { evidence_path: "../e1.md" })],
    ["evidence_path_invalid", (r) => rec(r, { evidence_path: "/etc/passwd" })],
    ["evidence_path_invalid", (r) => rec(r, { evidence_path: "docs/other/e1.md" })],
    ["evidence_path_invalid", (r) => rec(r, { evidence_path: "docs/evidence/e1.txt" })],
    ["evidence_path_invalid", (r) => rec(r, { evidence_path: "docs/evidence/sub/e1.md" })],
    ["evidence_path_invalid", (r) => rec(r, { evidence_path: "docs/evidence/e 1.md" })],
    ["evidence_missing", (r) => rec(r, { evidence_path: "docs/evidence/finnes-ikke.md" })],
    ["evidence_time_invalid", (r) => rec(r, { now: "i dag" })],
    ["reason_invalid", (r) => rec(r, { reason: "ab" })],
    ["reason_invalid", (r) => rec(r, { reason: "   " })],
    ["reason_invalid", (r) => rec(r, { reason: "x".repeat(201) })],
    ["evidence_from_stdin", (r) => {
      put(r, "docs/evidence/stdin.md", realEvidence({ stdin: true }));
      return rec(r, { evidence_path: "docs/evidence/stdin.md" });
    }],
    ["evidence_exit_not_zero", (r) => {
      put(r, "docs/evidence/feilet.md", realEvidence({ code: 1 }));
      return rec(r, { evidence_path: "docs/evidence/feilet.md" });
    }],
    ["evidence_exit_unknown", (r) => {
      put(r, "docs/evidence/uten-exit.md", `# Hjemmelaget\n\n- **Tidspunkt (UTC):** ${VERIFIED}\n- **Git:** \`${SHA_EVIDENCE}\` på \`main\`\n\n## Utdata\n\nok\n`);
      return rec(r, { evidence_path: "docs/evidence/uten-exit.md" });
    }],
    ["external_confirmation_required", (r) => {
      writeGate(r, "G01", { external: true });
      return rec(r);
    }],
    ["verified_at_after_evidence", (r) => rec(r, { verified_at: "2026-11-26T13:30:00.000Z" })],
    ["concurrent_registration", (r) => {
      acquireLock(join(r, "config/program/.G01.lock"));
      return rec(r, { write: true });
    }]
  ];
  for (const [expected, run] of cases) {
    it(`${expected}`, () => {
      const { root } = miniRepo();
      evidence(root, "e1");
      expect(problem(run(root))).toBe(expected);
    });
  }

  it("evidence_not_allowed_for_open: en gjenåpning har ingen evidens", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    expect(rec(root, { write: true }).ok).toBe(true);
    expect(problem(rec(root, { status: "OPEN", evidence_path: "docs/evidence/e1.md", now: "2026-11-26T15:00:00.000Z" }))).toBe("evidence_not_allowed_for_open");
  });

  it("evidence_not_regular_file: symlenke og mapper avvises", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    symlinkSync(join(root, "docs/evidence/e1.md"), join(root, "docs/evidence/lenke.md"));
    mkdirSync(join(root, "docs/evidence/mappe.md"));
    expect(problem(rec(root, { evidence_path: "docs/evidence/lenke.md" }))).toBe("evidence_not_regular_file");
    expect(problem(rec(root, { evidence_path: "docs/evidence/mappe.md" }))).toBe("evidence_not_regular_file");
  });

  it("evidence_too_large: over 1 MB", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    writeFileSync(join(root, "docs/evidence/stor.md"), "x".repeat(1_000_001));
    expect(problem(rec(root, { evidence_path: "docs/evidence/stor.md" }))).toBe("evidence_too_large");
    // Grensen er nøyaktig 1 000 000 byte: en fil på akkurat det er ok (med en ekte topptekst inkl. Exit-linje), én byte til er for stor.
    const head = `- **Tidspunkt (UTC):** ${VERIFIED}\n- **Git:** \`${SHA_EVIDENCE}\` på \`main\`\n- **Exit:** 0\n`;
    const exact = head + "x".repeat(1_000_000 - Buffer.byteLength(head));
    expect(Buffer.byteLength(exact)).toBe(1_000_000);
    writeFileSync(join(root, "docs/evidence/akkurat.md"), exact);
    expect(problem(rec(root, { evidence_path: "docs/evidence/akkurat.md" }))).toBe("ok");
    writeFileSync(join(root, "docs/evidence/en-over.md"), `${exact}x`);
    expect(problem(rec(root, { evidence_path: "docs/evidence/en-over.md" }))).toBe("evidence_too_large");
  });

  it("time_before_last_change: kjeden er tidsmessig stigende", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    expect(rec(root, { write: true }).ok).toBe(true);
    expect(problem(rec(root, { status: "OPEN", evidence_path: null, now: "2026-11-26T13:59:59.999Z" }))).toBe("time_before_last_change");
    expect(problem(rec(root, { status: "OPEN", evidence_path: null, now: NOW }))).toBe("ok");
  });

  it("bound_component_unknown: porten er bundet til en komponent som ikke finnes", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    writeGate(root, "G01", { bound_components: ["core.alpha", "core.finnes-ikke"] });
    expect(problem(rec(root))).toBe("bound_component_unknown");
  });

  it("contract_fingerprint_outdated: kontraktfilen er endret uten at fingeravtrykket er oppdatert", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    put(root, "contracts/a.ts", "export const a = 2;\n");
    expect(problem(rec(root))).toBe("contract_fingerprint_outdated");
    refreshFingerprints(root, { write: true, now: "2026-11-26T12:30:00.000Z" });
    expect(problem(rec(root))).toBe("ok");
    put(root, "contracts/a.ts", "export const a = 3;\n");
    expect(problem(rec(root))).toBe("contract_fingerprint_outdated");
  });

  it("contract_fingerprint_outdated: en kontraktfil som er slettet teller også", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    writeFileSync(join(root, "contracts/a.ts"), "");
    expect(problem(rec(root))).toBe("contract_fingerprint_outdated");
  });

  it("evidence_older_than_contract_change: evidensen må være tatt ETTER siste kontraktendring (streng, ikke lik)", () => {
    const { root } = miniRepo();
    refreshFingerprints(root, { write: false, now: NOW });
    put(root, "contracts/a.ts", "export const a = 2;\n");
    refreshFingerprints(root, { write: true, now: "2026-11-26T13:00:00.000Z" });
    evidence(root, "e1", { time: "2026-11-26T12:59:59.999Z" });
    expect(problem(rec(root))).toBe("evidence_older_than_contract_change");
    evidence(root, "e2", { time: "2026-11-26T13:00:00.000Z" });
    expect(problem(rec(root, { evidence_path: "docs/evidence/e2.md" }))).toBe("ok");
  });

  it("prerequisite_not_pass: ORL-PASS krever at portene og forrige nivå står som PASS nå", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    writeGate(root, "ORL0", { requires_gates: ["G01"] });
    expect(problem(rec(root, { gate_id: "ORL0" }))).toBe("prerequisite_not_pass");
    expect(problem(rec(root, { gate_id: "ORL1" }))).toBe("prerequisite_not_pass");
    expect(rec(root, { write: true }).ok).toBe(true);
    expect(problem(rec(root, { gate_id: "ORL0" }))).toBe("ok");
    expect(rec(root, { gate_id: "ORL0", write: true }).ok).toBe(true);
    expect(problem(rec(root, { gate_id: "ORL1" }))).toBe("ok");
    // ORL FAIL og OPEN krever ingen forutsetninger.
    expect(problem(rec(root, { gate_id: "ORL2", status: "FAIL" }))).toBe("ok");
  });

  it("data_invalid: et ugyldig manifest stopper registreringen uten å skrive", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    put(root, "config/program/manifest.json", "{ ikke json");
    expect(problem(rec(root, { write: true }))).toBe("data_invalid");
    expect(readGate(root, "G01")["status"]).toBe("OPEN");
  });

  it("alle nektelseskoder er prøvd i denne filen (bortsett fra den defensive result_invalid)", () => {
    const sourceText = readFileSync(new URL(import.meta.url), "utf8");
    const untested = RECORD_PROBLEMS.filter((p) => p !== "result_invalid" && !sourceText.includes(`"${p}"`));
    expect(untested).toEqual([]);
  });
});

describe("gjenåpning og ny evidens etter en kontraktendring (staleness)", () => {
  it("PASS -> kontrakten endres -> porten er OPEN igjen og flagges -> gjenåpne -> ny evidens -> PASS", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    expect(rec(root, { write: true }).ok).toBe(true);
    expect(runProgramIndex({ root, env: undefined, origin: [] }).findings).toEqual([]);

    put(root, "contracts/a.ts", "export const a = 2;\n");
    refreshFingerprints(root, { write: true, now: "2026-11-26T15:00:00.000Z" });
    const stale = runProgramIndex({ root, env: undefined, origin: [] });
    expect(stale.findings.map((f) => f.id)).toEqual(["gate_stale:G01"]);
    expect(stale.counts.gates_effective).toEqual({ OPEN: 17, PASS: 0, FAIL: 0 });
    expect(stale.counts.gates_declared.PASS).toBe(1);

    // Samme status nektes: en foreldet PASS gjenåpnes først.
    expect(problem(rec(root, { now: "2026-11-26T15:10:00.000Z" }))).toBe("status_unchanged");
    expect(rec(root, { status: "OPEN", evidence_path: null, reason: "foreldet etter kontraktendring", now: "2026-11-26T15:20:00.000Z", write: true }).ok).toBe(true);
    // Den gamle evidensen er eldre enn kontraktendringen og kan ikke gjenbrukes.
    expect(problem(rec(root, { now: "2026-11-26T15:30:00.000Z" }))).toBe("evidence_older_than_contract_change");
    evidence(root, "e2", { time: "2026-11-26T15:25:00.000Z" });
    expect(rec(root, { evidence_path: "docs/evidence/e2.md", now: "2026-11-26T15:40:00.000Z", write: true }).ok).toBe(true);

    const gate = readGate(root, "G01") as { status: string; history: Array<{ prior_status: string; new_status: string; evidence_refs: unknown[] }> };
    expect(gate.history.map((h) => `${h.prior_status}>${h.new_status}`)).toEqual(["OPEN>PASS", "PASS>OPEN", "OPEN>PASS"]);
    expect(gate.history[1]!.evidence_refs).toEqual([]);
    expect(gate.status).toBe("PASS");
    const fresh = runProgramIndex({ root, env: undefined, origin: [] });
    expect(fresh.findings).toEqual([]);
    expect(fresh.counts.gates_effective.PASS).toBe(1);
  });

  it("evidensfilen endres etter registreringen: porten er OPEN igjen med gate_evidence_invalid", () => {
    const { root } = miniRepo();
    const path = evidence(root, "e1");
    expect(rec(root, { write: true }).ok).toBe(true);
    writeFileSync(join(root, path), `${readFileSync(join(root, path), "utf8")}\nendret etterpå\n`);
    const run = runProgramIndex({ root, env: undefined, origin: [] });
    expect(run.findings.map((f) => f.id)).toEqual(["gate_evidence_invalid:G01"]);
    expect(run.counts.gates_effective.PASS).toBe(0);
  });

  it("en bundet komponents kontraktendring registrert FØR evidensen gir ingen foreldelse", () => {
    const { root } = miniRepo();
    put(root, "contracts/a.ts", "export const a = 2;\n");
    refreshFingerprints(root, { write: true, now: "2026-11-26T12:30:00.000Z" });
    evidence(root, "e1");
    expect(rec(root, { write: true }).ok).toBe(true);
    expect(runProgramIndex({ root, env: undefined, origin: [] }).findings).toEqual([]);
  });
});

describe("historikken er append-only og ubrutt (200 oppføringer er taket)", () => {
  it("resultatet nektes (result_invalid) når historikken ville bli lengre enn 200", () => {
    const { root } = miniRepo();
    evidence(root, "e1");
    const fp = (loadProgramData(root).components.find((c) => c.component_id === "core.alpha") as { contract: { fingerprint: string } }).contract.fingerprint;
    const ref = (i: number) => ({ path: "docs/evidence/e1.md", sha256: sha256Hex(readFileSync(join(root, "docs/evidence/e1.md"), "utf8")), git_sha: SHA_EVIDENCE, recorded_at: `2026-11-26T13:${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, verified_at: VERIFIED, verified_at_source: "evidence_header", contract_fingerprints: { "core.alpha": fp } });
    const history = Array.from({ length: 200 }, (_, i) => {
      const toPass = i % 2 === 0;
      const at = `2026-11-26T13:${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`;
      return { gate_kind: "program_gate", gate_id: "G01", prior_status: toPass ? "OPEN" : "PASS", new_status: toPass ? "PASS" : "OPEN", evidence_refs: toPass ? [ref(i)] : [], owner: "owner", changed_at: at, reason: `overgang ${i}` };
    });
    writeGate(root, "G01", { status: "OPEN", evidence_ref: null, history });
    expect(loadProgramData(root).gates.find((g) => g.id === "G01")?.history).toHaveLength(200);
    const r = rec(root, { now: "2026-11-26T20:00:00.000Z" });
    expect(problem(r)).toBe("result_invalid");
  });
});
