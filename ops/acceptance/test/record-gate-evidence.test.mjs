import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gateArgs } from "../record-gate-evidence.mjs";
import { miniRepo, put } from "../../../packages/contracts/test/program-index-minirepo.ts";

// WP-PGA / PG3: inngangen `record-gate-evidence.mjs` (porteregistrering). Kjører selve skriptet som en egen prosess mot et midlertidig mini-repo.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "record-gate-evidence.mjs");

function runScript(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", shell: false, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const evidence = (root) => put(root, "docs/evidence/e1.md", `# Evidens e1\n\n- **Tidspunkt (UTC):** 2026-11-26T13:00:00.000Z\n- **Git:** \`${"a".repeat(40)}\` på \`main\`\n- **Exit:** 0\n\n## Utdata\n\nok\n`);
const gateFile = (root, id) => JSON.parse(readFileSync(join(root, "config/program", id.startsWith("ORL") ? "orl" : "gates", `${id}.json`), "utf8"));

describe("gateArgs (kun `gate` slippes igjennom)", () => {
  it("godtar gyldig port/nivå og status; avviser alt annet", () => {
    expect(gateArgs(["G01", "PASS", "--write"])).toEqual(["gate", "G01", "PASS", "--write"]);
    expect(gateArgs(["ORL5", "OPEN"])).toEqual(["gate", "ORL5", "OPEN"]);
    for (const bad of [[], ["G18", "PASS"], ["G00", "PASS"], ["ORL6", "PASS"], ["g01", "PASS"], ["G01"], ["G01", "pass"], ["G01", "DONE"], ["fingerprint", "--write"], ["report"], ["--write", "G01", "PASS"]]) {
      expect(gateArgs(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("record-gate-evidence.mjs (egen prosess)", () => {
  it("uten argumenter eller med feil argumenter: exit 2 og bruksteksten", () => {
    for (const args of [[], ["G01"], ["G01", "BOGUS"], ["fingerprint", "--write"]]) {
      const r = runScript(args);
      expect(r.code, JSON.stringify(args)).toBe(2);
      expect(r.err).toContain("bruk:");
    }
  });

  it("tørrkjøring skriver ikke; --write registrerer PASS; samme status på nytt gir exit 1", () => {
    const { root } = miniRepo();
    evidence(root);
    const base = ["G01", "PASS", "--root", root, "--reason", "bevist i testen", "--by", "owner", "--evidence", "docs/evidence/e1.md"];
    const dry = runScript(base);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("tørrkjøring");
    expect(gateFile(root, "G01").status).toBe("OPEN");
    const done = runScript([...base, "--write"]);
    expect(done.code).toBe(0);
    expect(done.out).toContain("OPEN -> PASS");
    const gate = gateFile(root, "G01");
    expect(gate.status).toBe("PASS");
    expect(gate.history).toHaveLength(1);
    expect(gate.evidence_ref.path).toBe("docs/evidence/e1.md");
    const again = runScript([...base, "--write"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("status_unchanged");
  });

  it("nektelser (evidens mangler, personnavn som rolle) gir exit 1/2 og skriver ingenting", () => {
    const { root } = miniRepo();
    expect(runScript(["G01", "PASS", "--root", root, "--reason", "grunn", "--by", "owner"]).code).toBe(1);
    expect(runScript(["G01", "PASS", "--root", root, "--reason", "grunn", "--by", "en-person", "--evidence", "docs/evidence/e1.md", "--write"]).code).toBe(2);
    expect(gateFile(root, "G01").status).toBe("OPEN");
    expect(gateFile(root, "G01").history).toEqual([]);
  });

  it("ingen skall: metategn i begrunnelsen blir bokstavelig tekst og kjører aldri", () => {
    const { root } = miniRepo();
    evidence(root);
    const marker = join(root, "markoer-skal-ikke-finnes");
    const reason = `a; touch ${marker} && echo $(id)`;
    const r = runScript(["G01", "PASS", "--root", root, "--reason", reason, "--by", "platform_operator", "--evidence", "docs/evidence/e1.md", "--write"]);
    expect(r.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(gateFile(root, "G01").history[0].reason).toBe(reason);
  });
});
