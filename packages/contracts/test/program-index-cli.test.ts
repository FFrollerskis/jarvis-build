import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../scripts/program-index.ts";
import { json, miniRepo, put } from "./program-index-minirepo.ts";

/**
 * WP-PGA: kommandolinjen (`scripts/program-index.ts`) kalt som funksjon mot et midlertidig mini-repo. Dekker kommandoene report/index/fingerprint/gate, exit-koder, modusbryteren og bruksfeil.
 */
interface Result {
  code: number;
  out: string[];
  err: string[];
}
function cli(args: string[], env: NodeJS.ProcessEnv = {}): Result {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, env, (l) => out.push(l), (l) => err.push(l));
  return { code, out, err };
}

describe("report", () => {
  it("rent repo: exit 0 og en lesbar rapport; --json gir samme tall", () => {
    const { root } = miniRepo();
    const text = cli(["report", "--root", root]);
    expect(text.code).toBe(0);
    expect(text.out.join("\n")).toContain("Dom: OK");
    expect(text.out.join("\n")).toContain("3 komponenter");
    const j = cli(["report", "--root", root, "--json"]);
    const parsed = JSON.parse(j.out.join("\n")) as { verdict: { ok: boolean }; counts: { components_total: number }; mode: { mode: string }; digest: string; findings: unknown[] };
    expect(parsed.verdict.ok).toBe(true);
    expect(parsed.counts.components_total).toBe(3);
    expect(parsed.mode.mode).toBe("report");
    expect(parsed.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.findings).toEqual([]);
  });

  it("modusbryteren: et nytt funn er ok i report og rødt i enforce (miljøet kan kun stramme inn)", () => {
    const { root } = miniRepo();
    put(root, "db/003_c.sql", "CREATE TABLE t_c (tenant_id text);\n");
    const rep = cli(["report", "--root", root]);
    expect(rep.code).toBe(0);
    expect(rep.out.join("\n")).toContain("table_orphan");
    expect(rep.out.join("\n")).toContain("report-modus");
    const enf = cli(["report", "--root", root], { PROGRAM_INDEX_MODE: "enforce" });
    expect(enf.code).toBe(1);
    expect(enf.out.join("\n")).toContain("Dom: RØD");
    expect(cli(["report", "--root", root], { PROGRAM_INDEX_MODE: "report" }).code).toBe(0);
  });

  it("en manifestverdi enforce kan ikke svekkes av miljøet (PROGRAM_INDEX_MODE=report)", () => {
    const { root } = miniRepo((m) => {
      m.guard = { ...m.guard, mode: "enforce" };
    });
    put(root, "db/003_c.sql", "CREATE TABLE t_c (tenant_id text);\n");
    expect(cli(["report", "--root", root], { PROGRAM_INDEX_MODE: "report" }).code).toBe(1);
  });

  it("ugyldig PROGRAM_INDEX_MODE er et brudd (exit 1), aldri en stille report", () => {
    const { root } = miniRepo();
    for (const bad of ["Enforce", "enforce ", "on", "1"]) {
      const r = cli(["report", "--root", root], { PROGRAM_INDEX_MODE: bad });
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain("ugyldig vaktmodus");
    }
  });

  it("ugyldig manifest: DATAFEIL med exit 1", () => {
    const { root } = miniRepo();
    put(root, "config/program/manifest.json", "{}");
    const r = cli(["report", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("DATAFEIL (manifest_invalid)");
  });

  it("--max begrenser antall funnlinjer i rapporten", () => {
    const { root } = miniRepo();
    put(root, "db/003_c.sql", "CREATE TABLE t_c (tenant_id text);\nCREATE TABLE t_d (tenant_id text);\n");
    const all = cli(["report", "--root", root, "--max", "10"]).out.join("\n");
    expect(all).toContain("t_c");
    expect(all).toContain("t_d");
    const one = cli(["report", "--root", root, "--max", "1"]).out.join("\n");
    expect(one).toContain("og 2 til");
  });
});

describe("index", () => {
  it("skriver den kanoniske sammenslåtte indeksen med digest, 17 porter og 6 nivåer", () => {
    const { root } = miniRepo();
    const r = cli(["index", "--root", root]);
    expect(r.code).toBe(0);
    const idx = JSON.parse(r.out.join("\n")) as { format: string; components: Array<{ component_id: string }>; gates: unknown[]; orls: unknown[]; digest: string };
    expect(idx.format).toBe("program-index/1");
    expect(idx.components.map((c) => c.component_id)).toEqual(["ci.gamma", "core.alpha", "core.beta"]);
    expect(idx.gates).toHaveLength(17);
    expect(idx.orls).toHaveLength(6);
    expect(idx.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(cli(["index", "--root", root]).out.join("\n")).digest).toBe(idx.digest);
  });
});

describe("fingerprint", () => {
  it("à jour: exit 0; avvik uten --write: exit 1 og ingenting skrives; med --write: oppdatert og exit 0", () => {
    const { root } = miniRepo();
    expect(cli(["fingerprint", "--root", root]).code).toBe(0);
    put(root, "contracts/a.ts", "export const a = 2;\n");
    const before = readFileSync(join(root, "config/program/components/core.alpha.json"), "utf8");
    const dry = cli(["fingerprint", "--root", root]);
    expect(dry.code).toBe(1);
    expect(dry.out.join("\n")).toContain("AVVIK");
    expect(readFileSync(join(root, "config/program/components/core.alpha.json"), "utf8")).toBe(before);
    const written = cli(["fingerprint", "--root", root, "--write"]);
    expect(written.code).toBe(0);
    expect(written.out.join("\n")).toContain("oppdatert");
    expect(readFileSync(join(root, "config/program/components/core.alpha.json"), "utf8")).not.toBe(before);
    expect(cli(["fingerprint", "--root", root]).code).toBe(0);
  });

  it("--bump krever --write og en gyldig verdi; en bump uten endring gjøres ikke", () => {
    const { root } = miniRepo();
    expect(cli(["fingerprint", "--root", root, "--bump", "minor"]).code).toBe(2);
    expect(cli(["fingerprint", "--root", root, "--write", "--bump", "huge"]).code).toBe(2);
    const noChange = cli(["fingerprint", "core.alpha", "--root", root, "--write", "--bump", "minor"]);
    expect(noChange.code).toBe(1);
    expect(noChange.out.join("\n")).toContain("ingen kontraktendring");
    expect(noChange.out.join("\n")).not.toContain("->");
    put(root, "contracts/a.ts", "export const a = 2;\n");
    const bumped = cli(["fingerprint", "core.alpha", "--root", root, "--write", "--bump", "minor"]);
    expect(bumped.code).toBe(0);
    expect(bumped.out.join("\n")).toContain("0.1.0 -> 0.2.0");
  });

  it("ukjent komponent gir exit 1", () => {
    const { root } = miniRepo();
    const r = cli(["fingerprint", "core.finnes-ikke", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toContain("ukjent komponent");
  });
});

describe("gate", () => {
  const evidenceFile = (root: string): void =>
    put(root, "docs/evidence/e1.md", `# Evidens e1\n\n- **Tidspunkt (UTC):** 2026-11-26T13:00:00.000Z\n- **Git:** \`${"a".repeat(40)}\` på \`main\`\n- **Exit:** 0\n\n## Utdata\n\nok\n`);

  it("tørrkjøring skriver ikke; --write registrerer; samme status på nytt nektes", () => {
    const { root } = miniRepo();
    evidenceFile(root);
    // Evidensen er datert 2026-11-26T13:00 og «nå» er systemtiden: registreringstidspunktet ligger etter evidensen.
    const args = ["gate", "G01", "PASS", "--root", root, "--reason", "bevist i testen", "--by", "owner", "--evidence", "docs/evidence/e1.md"];
    const dry = cli(args);
    expect(dry.code).toBe(0);
    expect(dry.out.join("\n")).toContain("tørrkjøring");
    expect((JSON.parse(readFileSync(join(root, "config/program/gates/G01.json"), "utf8")) as { status: string }).status).toBe("OPEN");
    const done = cli([...args, "--write"]);
    expect(done.code).toBe(0);
    expect(done.out.join("\n")).toContain("OPEN -> PASS");
    expect((JSON.parse(readFileSync(join(root, "config/program/gates/G01.json"), "utf8")) as { status: string }).status).toBe("PASS");
    const again = cli([...args, "--write"]);
    expect(again.code).toBe(1);
    expect(again.err.join("\n")).toContain("status_unchanged");
  });

  it("nektelser gir exit 1 med kode; bruksfeil gir exit 2", () => {
    const { root } = miniRepo();
    const base = ["--root", root, "--reason", "grunn", "--by", "owner"];
    expect(cli(["gate", "G01", "PASS", ...base]).err.join("\n")).toContain("evidence_required");
    expect(cli(["gate", "G01", "PASS", ...base]).code).toBe(1);
    expect(cli(["gate", "G01", "BOGUS", ...base]).code).toBe(2);
    expect(cli(["gate", "G01", "PASS", "--root", root, "--by", "owner"]).code).toBe(2);
    expect(cli(["gate", "G01", "PASS", "--root", root, "--reason", "grunn"]).code).toBe(2);
    expect(cli(["gate", "G01", "PASS", "--root", root, "--reason", "grunn", "--by", "en-person"]).code).toBe(2);
    expect(cli(["gate", "G01", "--root", root, "--reason", "grunn", "--by", "owner"]).code).toBe(2);
    expect(cli(["gate", "G01", "PASS", "ekstra", ...base]).code).toBe(2);
  });

  it("advarsler (svak evidens) skrives til stderr, ikke stdout; uten git-SHA noe sted nektes registreringen", () => {
    const { root } = miniRepo();
    put(root, "docs/evidence/e1.md", `# Evidens uten tidspunkt\n\n- **Git:** \`${"a".repeat(40)}\` på \`main\` (**ucommittede endringer i arbeidstreet**)\n- **Exit:** 0\n\n## Utdata\n\nok\n`);
    const args = ["gate", "G01", "PASS", "--root", root, "--reason", "grunn", "--by", "platform_operator", "--evidence", "docs/evidence/e1.md"];
    const weak = cli(args);
    expect(weak.code).toBe(0);
    expect(weak.err.filter((l) => l.startsWith("ADVARSEL"))).toHaveLength(2);
    expect(weak.out.join("\n")).toContain("registration_time");
    put(root, "docs/evidence/e2.md", "# Evidens uten topptekst\n\n- **Exit:** 0\n");
    const none = cli(["gate", "G02", "PASS", "--root", root, "--reason", "grunn", "--by", "owner", "--evidence", "docs/evidence/e2.md"]);
    // Verken evidensen eller arbeidstreet (mini-repoet er ikke et git-repo) har en SHA: nektes.
    expect(none.code).toBe(1);
    expect(none.err.join("\n")).toContain("git_sha_unavailable");
  });
});

describe("bruk", () => {
  it("manglende/ukjent kommando, ukjent valg og manglende verdi gir exit 2 med bruksteksten", () => {
    const { root } = miniRepo();
    for (const args of [[], ["bogus"], ["report", "--bogus"], ["report", "--root"], ["report", "ekstra", "--root", root], ["index", "ekstra", "--root", root], ["report", "--root", root, "--root", root], ["report", "--root", root, "--max", "-1"], ["report", "--root", root, "--max", "abc"]]) {
      const r = cli(args);
      expect(r.code, JSON.stringify(args)).toBe(2);
      expect(r.err.join("\n")).toContain("bruk:");
    }
  });

  it("json-hjelperen er stabil (brukes av fixtures)", () => {
    expect(json({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});
