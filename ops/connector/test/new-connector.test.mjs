import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES_DIR, GeneratorError, ID_PATTERN, main, normalize, parseArgs, planFiles, render, writePlan } from "../new-connector.mjs";

/**
 * WP-I (D-472): tester for scaffold-generatoren `ops/connector/new-connector.mjs`. ALT genereres inn i en midlertidig mappe (aldri inn i repoet); ingen nettverk.
 */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "new-connector.mjs");
const tmp = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "wpi-scaffold-")); tmp.push(d); return d; };
afterEach(() => { while (tmp.length > 0) rmSync(tmp.pop(), { recursive: true, force: true }); });

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const listFiles = (root) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out.push(relative(root, p).split("\\").join("/")); } };
  if (existsSync(root)) walk(root);
  return out.sort();
};
const quiet = { log: () => {}, err: () => {} };

describe("generering inn i en midlertidig mappe", () => {
  it("lager manifest, fake-adapter, kontraktstest og runbook-stub på de dokumenterte stedene (kode 0)", () => {
    const root = fresh();
    const r = run(["--id", "acme_tasks", "--name", "Acme Tasks", "--vendor", "Acme Corp", "--root", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(listFiles(root)).toEqual([
      "docs/runbooks/CONNECTOR_ACME_TASKS.md",
      "modules/connector-sdk/src/manifests/acme_tasks.ts",
      "modules/connector-sdk/test/connectors/acme_tasks.contract.test.ts",
      "modules/connector-sdk/test/connectors/acme_tasks.fake.ts"
    ]);
    expect(r.stdout).toContain("NESTE STEG");
    expect(r.stdout).toContain("CORE_DEPENDENCY_DECISION_REQUIRED=true");
  });

  it("innholdet er utfylt (ingen rest av plassholdere), utkast-merket, og peker på D-64/D-41 og riktig runbook/teststier", () => {
    const root = fresh();
    expect(run(["--id", "acme_tasks", "--name", "Acme Tasks", "--root", root]).status).toBe(0);
    const manifest = readFileSync(join(root, "modules/connector-sdk/src/manifests/acme_tasks.ts"), "utf8");
    const fake = readFileSync(join(root, "modules/connector-sdk/test/connectors/acme_tasks.fake.ts"), "utf8");
    const test = readFileSync(join(root, "modules/connector-sdk/test/connectors/acme_tasks.contract.test.ts"), "utf8");
    const runbook = readFileSync(join(root, "docs/runbooks/CONNECTOR_ACME_TASKS.md"), "utf8");
    for (const f of [manifest, fake, test, runbook]) expect(f).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(manifest).toContain('export const ACME_TASKS_MANIFEST: ConnectorManifest');
    expect(manifest).toContain('completeness: "skeleton"');
    expect(manifest).toContain('id: "acme_tasks"');
    expect(manifest).toContain('"docs/runbooks/CONNECTOR_ACME_TASKS.md"');
    expect(manifest).toContain('"modules/connector-sdk/test/connectors/acme_tasks.contract.test.ts"');
    expect(manifest).toContain("D-64");
    expect(manifest).toContain("D-41");
    expect(manifest).toContain('"acme_tasks.list_items"');
    expect(manifest).toContain('ref: "JARVIS_ACME_TASKS_TOKEN"');
    expect(fake).toContain("export function createAcmeTasksFake");
    expect(test).toContain('runConnectorContract(ACME_TASKS_MANIFEST, createAcmeTasksFake())');
    expect(test).toContain('toBe("R")');
    expect(runbook).toContain("NOT_BUILT / UTKAST");
    expect(runbook).toContain("NOT VERIFIED");
    expect(runbook).toContain("Core-vs-Adapter");
    expect(manifest).not.toMatch(/(ghp_|sk_live_|AKIA[0-9A-Z]{8})/);
  });

  it("--write gir en skrivehandling (klasse B), dedupe-nøkkel og akseptansenivå A; uten --write er det ren lesing (nivå R)", () => {
    const w = fresh();
    expect(run(["--id", "acme_tasks", "--name", "Acme Tasks", "--write", "--root", w]).status).toBe(0);
    const m = readFileSync(join(w, "modules/connector-sdk/src/manifests/acme_tasks.ts"), "utf8");
    expect(m).toContain('"acme_tasks.create_item"');
    expect(m).toContain('dedupe_key: "jarvis_idempotency_key"');
    expect(m).toContain('write: { status: "implemented" }');
    expect(m).toContain("max_ms: 15_000");
    expect(readFileSync(join(w, "modules/connector-sdk/test/connectors/acme_tasks.contract.test.ts"), "utf8")).toContain('toBe("A")');
    const r = fresh();
    expect(run(["--id", "acme_tasks", "--name", "Acme Tasks", "--root", r]).status).toBe(0);
    const ro = readFileSync(join(r, "modules/connector-sdk/src/manifests/acme_tasks.ts"), "utf8");
    expect(ro).not.toContain("create_item");
    expect(ro).toContain('dedupe_key: "none"');
    expect(ro).toContain('write: { status: "not_implemented" }');
  });

  it("--tool-id styrer handlingsnøkkelen (verktøy-id er ikke alltid lik connector-id, f.eks. google_calendar -> calendar)", () => {
    const root = fresh();
    expect(run(["--id", "acme_tasks", "--tool-id", "tasks-api", "--name", "Acme Tasks", "--root", root]).status).toBe(0);
    expect(readFileSync(join(root, "modules/connector-sdk/src/manifests/acme_tasks.ts"), "utf8")).toContain('"tasks-api.list_items"');
    expect(readFileSync(join(root, "modules/connector-sdk/test/connectors/acme_tasks.fake.ts"), "utf8")).toContain('"tasks-api.list_items"');
  });

  it("er deterministisk: samme argumenter gir identiske filer i to ulike mapper", () => {
    const a = fresh(); const b = fresh();
    expect(run(["--id", "acme_tasks", "--name", "Acme Tasks", "--vendor", "Acme Corp", "--write", "--root", a]).status).toBe(0);
    expect(run(["--id", "acme_tasks", "--name", "Acme Tasks", "--vendor", "Acme Corp", "--write", "--root", b]).status).toBe(0);
    for (const f of listFiles(a)) expect(readFileSync(join(a, f), "utf8")).toBe(readFileSync(join(b, f), "utf8"));
  });

  it("--dry-run skriver ingenting men lister filene", () => {
    const root = fresh();
    const r = run(["--id", "acme_tasks", "--name", "Acme Tasks", "--dry-run", "--root", root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("TØRRKJØRING");
    expect(r.stdout).toContain("modules/connector-sdk/src/manifests/acme_tasks.ts");
    expect(listFiles(root)).toEqual([]);
  });
});

describe("NEKTER Å OVERSKRIVE", () => {
  it("andre kjøring med samme id avslutter med kode 2 og lar alle filer være uendret", () => {
    const root = fresh();
    expect(run(["--id", "acme_tasks", "--name", "Acme Tasks", "--root", root]).status).toBe(0);
    const manifest = join(root, "modules/connector-sdk/src/manifests/acme_tasks.ts");
    writeFileSync(manifest, "// eierens redigering\n");
    const before = listFiles(root).map((f) => [f, readFileSync(join(root, f), "utf8")]);
    const r = run(["--id", "acme_tasks", "--name", "Annet Navn", "--root", root]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("nekter å overskrive");
    expect(listFiles(root).map((f) => [f, readFileSync(join(root, f), "utf8")])).toEqual(before);
    expect(readFileSync(manifest, "utf8")).toBe("// eierens redigering\n");
  });

  it("er det BARE én eksisterende målfil, skrives ingen av de andre (alt eller ingenting)", () => {
    const root = fresh();
    const runbook = join(root, "docs/runbooks/CONNECTOR_ACME_TASKS.md");
    mkdirSync(dirname(runbook), { recursive: true });
    writeFileSync(runbook, "eksisterende runbook\n");
    const r = run(["--id", "acme_tasks", "--name", "Acme Tasks", "--root", root]);
    expect(r.status).toBe(2);
    expect(listFiles(root)).toEqual(["docs/runbooks/CONNECTOR_ACME_TASKS.md"]);
    expect(readFileSync(runbook, "utf8")).toBe("eksisterende runbook\n");
  });

  it("er en sti i veien midt i skrivingen (en FIL der en mappe trengs), fjernes det kjøringen allerede laget, og den blokkerende filen røres ikke", () => {
    const root = fresh();
    mkdirSync(join(root, "modules/connector-sdk/test"), { recursive: true });
    writeFileSync(join(root, "modules/connector-sdk/test/connectors"), "i veien\n");
    const r = run(["--id", "acme_tasks", "--name", "Acme Tasks", "--root", root]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("nekter å overskrive");
    expect(readFileSync(join(root, "modules/connector-sdk/test/connectors"), "utf8")).toBe("i veien\n");
    expect(listFiles(root)).toEqual(["modules/connector-sdk/test/connectors"]);
  });

  it("writePlan nekter målstier utenfor --root (aldri skriving utenfor rotmappen)", () => {
    const root = fresh();
    expect(() => writePlan(root, [{ path: "../utenfor.txt", content: "x" }])).toThrow(GeneratorError);
    expect(existsSync(join(root, "..", "utenfor.txt"))).toBe(false);
  });
});

describe("ugyldig inndata gir kode 1 og skriver ingenting", () => {
  const bad = [
    [["--name", "X"], "--id"],
    [["--id", "acme_tasks"], "--name"],
    [["--id", "Acme", "--name", "X"], "--id"],
    [["--id", "../evil", "--name", "X"], "--id"],
    [["--id", "a", "--name", "X"], "--id"],
    [["--id", "acme tasks", "--name", "X"], "--id"],
    [["--id", "acme_tasks", "--name", 'Slik "x"'], "--name"],
    [["--id", "acme_tasks", "--name", "Slik\nlinje"], "--name"],
    [["--id", "acme_tasks", "--name", "a */ b"], "--name"],
    [["--id", "acme_tasks", "--name", "a`b"], "--name"],
    [["--id", "acme_tasks", "--name", "X", "--vendor", "${process.exit()}"], "--vendor"],
    [["--id", "acme_tasks", "--name", "X", "--tool-id", "Bad Tool"], "--tool-id"],
    [["--id", "acme_tasks", "--name", "X", "--bogus"], "ukjent argument"],
    [["--id"], "krever en verdi"]
  ];
  it.each(bad)("%j", (args, needle) => {
    const root = fresh();
    const r = run([...args, "--root", root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(needle);
    expect(listFiles(root)).toEqual([]);
  });

  it("injeksjonsforsøk i visningsnavnet kan aldri bryte ut av TS-strenger eller kommentarer (avvises)", () => {
    for (const evil of ['"; process.exit(1); "', "x */ import('fs') /*", "${1+1}", "a\\b", "x`y"]) {
      expect(() => normalize({ id: "acme_tasks", name: evil, write: false })).toThrow(GeneratorError);
    }
    // Tillatte tegn (norske bokstaver, mellomrom, bindestrek, punktum, parentes) er trygge og utfylt som JSON-strenger.
    const n = normalize({ id: "acme_tasks", name: "Åse & Øvre (v2) - AS.", write: false });
    expect(placeholders_json(n)).toBe('"Åse & Øvre (v2) - AS."');
  });

  it("id-mønsteret er det samme som connector-id i skjemaet (snake_case)", () => {
    expect(ID_PATTERN.test("google_sheets")).toBe(true);
    expect(ID_PATTERN.test("1abc")).toBe(false);
    expect(ID_PATTERN.test("a".repeat(42))).toBe(false);
  });

  it("main() returnerer kode uten å kaste, også ved uventet inndata, og hjelp gir kode 0", () => {
    expect(main(["--help"], quiet)).toBe(0);
    expect(main(["--id", "x"], quiet)).toBe(1);
    expect(main([], quiet)).toBe(1);
  });

  it("parseArgs avviser verdi som ser ut som et flagg", () => {
    expect(() => parseArgs(["--id", "--name"])).toThrow(GeneratorError);
  });
});

describe("malene", () => {
  it("alle fire malene finnes, og hver plassholder i dem er kjent for generatoren (ingen foreldreløse eller manglende)", () => {
    const names = readdirSync(DEFAULT_TEMPLATES_DIR).filter((f) => f.endsWith(".tmpl")).sort();
    expect(names).toEqual(["contract.test.ts.tmpl", "fake-adapter.ts.tmpl", "manifest.ts.tmpl", "runbook.md.tmpl"]);
    const plan = planFiles(normalize({ id: "acme_tasks", name: "Acme Tasks", write: true }));
    expect(plan.map((f) => f.path).length).toBe(4);
    for (const f of plan) expect(f.content).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("render avviser ukjent plassholder og etterlater aldri en tom verdi", () => {
    expect(() => render("a {{UKJENT}} b", { ID: "x" })).toThrow(GeneratorError);
    expect(render("a {{ID}} b", { ID: "x" })).toBe("a x b");
  });
});

function placeholders_json(n) {
  const plan = planFiles(n);
  const m = plan[0].content;
  const hit = /name: ("(?:[^"\\]|\\.)*"),/.exec(m);
  return hit ? hit[1] : "";
}
