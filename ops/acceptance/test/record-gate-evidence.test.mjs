import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gateArgs, reasonProblem, reasonProblemOf } from "../record-gate-evidence.mjs";
import { sanitize } from "../record-evidence.mjs";
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

describe("gateArgs: port-id-en er forankret i begge ender (fiks 1, M92)", () => {
  it("avviser en id med noe etter seg eller foran seg; godtar nøyaktig G01-G17 og ORL0-ORL5", () => {
    for (const bad of [["G011", "PASS"], ["G01x", "PASS"], ["G01 ", "PASS"], ["G01\n", "PASS"], ["G170", "PASS"], ["ORL01", "PASS"], ["ORL5x", "PASS"], ["ORL5\n", "PASS"], ["xG01", "PASS"], ["xORL0", "PASS"], ["G01/../x", "PASS"]]) {
      expect(gateArgs(bad), JSON.stringify(bad)).toBeNull();
    }
    for (let n = 1; n <= 17; n += 1) expect(gateArgs([`G${String(n).padStart(2, "0")}`, "OPEN"])).not.toBeNull();
    for (let n = 0; n <= 5; n += 1) expect(gateArgs([`ORL${n}`, "OPEN"])).not.toBeNull();
  });
});

describe("retningstegn og usynlige tegn i begrunnelsen (fiks 1, L1)", () => {
  const cp = (...c) => String.fromCodePoint(...c);
  it("sanitize fjerner retningstegn (U+202A-202E, U+2066-2069), myk bindestrek og Mongolsk vokalskille, i tillegg til de gamle tegnene", () => {
    for (const c of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x00ad, 0x180e, 0x200b, 0x2060, 0xfeff]) expect(sanitize(`a${cp(c)}b`), c.toString(16)).toBe("ab");
    expect(sanitize("vanlig tekst")).toBe("vanlig tekst");
  });

  it("reasonProblem og reasonProblemOf avviser retningstegn (tidligere null), uten å gjengi dem", () => {
    for (const c of [0x202e, 0x202d, 0x2066, 0x2069]) {
      const reason = `ok ${cp(c)}evil done`;
      const msg = reasonProblem(["gate", "G01", "PASS", "--reason", reason]);
      expect(msg, c.toString(16)).toContain("retningstegn");
      expect(msg).not.toContain(cp(c));
      expect(reasonProblemOf(reason)).toBe(msg);
    }
    expect(reasonProblemOf("vanlig begrunnelse uten skjulte tegn")).toBeNull();
    expect(reasonProblemOf(`${cp(0x200b)}skjult`)).toContain("kontrolltegn");
  });
});

// Hemmelighetsformede verdier bygges ved kjøring (aldri som bokstaver i kilden): ellers ville vi selv sluppet en hemmelighetsform inn i repoet.
const fakeToken = () => ["gh", "p_"].join("") + "A1b2C3d4".repeat(5);
const fakeKv = () => ["pass", "word"].join("") + "=" + ["x7Kq", "9mZp", "42Lw"].join("");

describe("reasonProblem (begrunnelsen havner i en offentlig, committet fil)", () => {
  it("avviser hemmelighetsformer (kun regelnavn i meldingen, aldri verdien) og kontrolltegn; godtar vanlig tekst", () => {
    for (const secret of [fakeToken(), fakeKv(), `bevist med ${fakeToken()} i kjøringen`]) {
      const msg = reasonProblem(["gate", "G01", "PASS", "--reason", secret]);
      expect(msg, secret.slice(0, 6)).not.toBeNull();
      expect(msg).not.toContain(secret);
      expect(msg).not.toContain("A1b2C3d4");
    }
    expect(reasonProblem(["gate", "G01", "PASS", "--reason", "bevist \u200bmed kontrolltegn"])).toContain("kontrolltegn");
    expect(reasonProblem(["gate", "G01", "PASS", "--reason", "foreldet etter kontraktendring i policy-modulen"])).toBeNull();
    expect(reasonProblem(["gate", "G01", "PASS"])).toBeNull();
    expect(reasonProblem(["gate", "G01", "PASS", "--reason"])).toBeNull();
  });
});

describe("record-gate-evidence.mjs (egen prosess)", () => {
  it("en begrunnelse med hemmelighetsform nektes (exit 2) og noe skrives aldri", () => {
    const { root } = miniRepo();
    evidence(root);
    const secret = fakeToken();
    const r = runScript(["G01", "PASS", "--root", root, "--reason", secret, "--by", "owner", "--evidence", "docs/evidence/e1.md", "--write"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("reason_secret");
    expect(r.err).not.toContain(secret);
    expect(gateFile(root, "G01").history).toEqual([]);
  });

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
