import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES_DIR, GeneratorError, ID_PATTERN, errorLabel, main, normalize, parseArgs, planFiles, render, secretKinds, writePlan } from "../new-connector.mjs";

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
    // Review M3: malen forhåndssvarer ALDRI D-64-porten - svarene står som ukjent til porten er kjørt og loggført.
    expect(manifest).toContain('basis: "unassessed"');
    expect(manifest).not.toMatch(/system_of_record:\s*"(JARVIS_CANONICAL|EXTERNAL_CANONICAL|HYBRID_WITH_CLEAR_AUTHORITY)"/);
    expect(manifest).not.toMatch(/core_dependency_decision_required:\s*(true|false)\b/);
    expect(manifest).toMatch(/system_of_record: unknownField\(/);
    expect(manifest).toMatch(/core_dependency_decision_required: unknownField\(/);
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

describe("FORHERDING (review LOW): symlenker, mapper, id-form, usynlige tegn og --root /", () => {
  /** Alle oppføringer (filer OG mapper, også symlenker) under en mappe, relativt, sortert. */
  const tree = (root) => (existsSync(root) ? readdirSync(root, { recursive: true }).map((p) => String(p).split("\\").join("/")).sort() : []);

  it("en symlenke INNE i --root som peker ut (manifests/ -> annen mappe) gir kode 1, og ingenting skrives - verken inni roten eller i målmappen (runbook §9: aldri utenfor --root)", () => {
    const root = fresh();
    const outside = fresh();
    mkdirSync(join(root, "modules/connector-sdk/src"), { recursive: true });
    symlinkSync(outside, join(root, "modules/connector-sdk/src/manifests"));
    const r = run(["--id", "acme_x", "--name", "Acme", "--root", root]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stderr).toContain("symlenke");
    expect(listFiles(outside)).toEqual([]);
    expect(tree(root)).toEqual(["modules", "modules/connector-sdk", "modules/connector-sdk/src", "modules/connector-sdk/src/manifests"]);
    expect(lstatSync(join(root, "modules/connector-sdk/src/manifests")).isSymbolicLink()).toBe(true);
  });

  it("en symlenke høyere opp (modules/ -> annen mappe) og en symlenke til en FIL som mappe stoppes også; writePlan kaster GeneratorError med kode 1", () => {
    const root = fresh();
    const outside = fresh();
    symlinkSync(outside, join(root, "modules"));
    expect(run(["--id", "acme_x", "--name", "Acme", "--root", root]).status).toBe(1);
    expect(tree(outside)).toEqual([]);
    const root2 = fresh();
    const outside2 = fresh();
    mkdirSync(join(root2, "docs"), { recursive: true });
    symlinkSync(outside2, join(root2, "docs/runbooks"));
    const plan = planFiles(normalize({ id: "acme_x", name: "Acme", write: false }));
    let caught;
    try { writePlan(root2, plan); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GeneratorError);
    expect(caught.exitCode).toBe(1);
    expect(tree(outside2)).toEqual([]);
    // Ingenting ble skrevet inni roten heller (sjekken skjer FØR noe skrives).
    expect(listFiles(root2)).toEqual([]);
  });

  it("en dinglende symlenke som mappe stoppes eksplisitt (kode 1, ikke en uventet feil), og ingenting dukker opp i målet", () => {
    const root = fresh();
    const outsideParent = fresh();
    const dangling = join(outsideParent, "finnes-ikke");
    mkdirSync(join(root, "modules/connector-sdk/src"), { recursive: true });
    symlinkSync(dangling, join(root, "modules/connector-sdk/src/manifests"));
    const r = run(["--id", "acme_x", "--name", "Acme", "--root", root]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("dinglende symlenke");
    expect(r.stderr).not.toContain("UVENTET");
    expect(existsSync(dangling)).toBe(false);
    expect(tree(outsideParent)).toEqual([]);
  });

  it("en symlenke som peker til et annet sted INNE i roten er lov (den slipper ikke noe ut)", () => {
    const root = fresh();
    mkdirSync(join(root, "modules/connector-sdk/src/ekte"), { recursive: true });
    symlinkSync(join(root, "modules/connector-sdk/src/ekte"), join(root, "modules/connector-sdk/src/manifests"));
    const r = run(["--id", "acme_x", "--name", "Acme", "--root", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, "modules/connector-sdk/src/ekte/acme_x.ts"))).toBe(true);
  });

  it("--root som selv er en symlenke til en mappe er eierens eksplisitte valg: filene havner i målmappen", () => {
    const real = fresh();
    const holder = fresh();
    const link = join(holder, "link");
    symlinkSync(real, link);
    const r = run(["--id", "acme_x", "--name", "Acme", "--root", link]);
    expect(r.status, r.stderr).toBe(0);
    expect(listFiles(real).length).toBe(4);
  });

  it("rollback fjerner mappene kjøringen selv opprettet (ikke bare filene), men aldri forhåndsfinnes mapper eller filer den ikke eier", () => {
    const root = fresh();
    mkdirSync(join(root, "modules/connector-sdk/test"), { recursive: true });
    writeFileSync(join(root, "modules/connector-sdk/test/connectors"), "i veien\n");
    const before = tree(root);
    const r = run(["--id", "acme_x", "--name", "Acme", "--root", root]);
    expect(r.status).toBe(2);
    // manifests/ og src/ ble opprettet for den første filen og skal være borte igjen; docs/ ble aldri nådd.
    expect(tree(root)).toEqual(before);
    expect(tree(root)).toEqual(["modules", "modules/connector-sdk", "modules/connector-sdk/test", "modules/connector-sdk/test/connectors"]);
    expect(readFileSync(join(root, "modules/connector-sdk/test/connectors"), "utf8")).toBe("i veien\n");
  });

  it("rollback rører ikke en mappe som ikke er tom (noe en annen la der) - rmdir, aldri rekursiv sletting", () => {
    const root = fresh();
    mkdirSync(join(root, "modules/connector-sdk/test"), { recursive: true });
    writeFileSync(join(root, "modules/connector-sdk/test/connectors"), "i veien\n");
    // Et eget (ikke-generert) filnavn legges i en mappe kjøringen skal opprette: den eksisterer da, og rollback lar den være.
    mkdirSync(join(root, "modules/connector-sdk/src/manifests"), { recursive: true });
    writeFileSync(join(root, "modules/connector-sdk/src/manifests/annet.ts"), "eierens fil\n");
    const r = run(["--id", "acme_x", "--name", "Acme", "--root", root]);
    expect(r.status).toBe(2);
    expect(readFileSync(join(root, "modules/connector-sdk/src/manifests/annet.ts"), "utf8")).toBe("eierens fil\n");
    expect(existsSync(join(root, "modules/connector-sdk/src/manifests/acme_x.ts"))).toBe(false);
  });

  it("--root / avvises ikke lenger feilaktig (tørrkjøring: ingenting skrives), mens ../ ut av en vanlig rot fortsatt stoppes", () => {
    const plan = planFiles(normalize({ id: "acme_x", name: "Acme", write: false }));
    expect(writePlan("/", plan, { dryRun: true })).toEqual([]);
    expect(main(["--id", "acme_x", "--name", "Acme", "--root", "/", "--dry-run"], quiet)).toBe(0);
    const root = fresh();
    expect(() => writePlan(root, [{ path: "../utenfor.txt", content: "x" }], { dryRun: true })).toThrow(GeneratorError);
    expect(() => writePlan(root, [{ path: ".", content: "x" }], { dryRun: true })).toThrow(GeneratorError);
  });

  it("id-formen: ab_, a__b, _ab og a_ avvises (de ga en ugyldig hvelvreferanse JARVIS_AB__TOKEN); a_b, ab, a1_b2 og lengdegrensene 2 og 41 er lovlige", () => {
    for (const bad of ["ab_", "a__b", "_ab", "a_", "a", "a".repeat(42), "a-b", "A_b"]) expect(ID_PATTERN.test(bad), bad).toBe(false);
    for (const good of ["a_b", "ab", "a1_b2", "ab", "a".repeat(41), "google_sheets"]) expect(ID_PATTERN.test(good), good).toBe(true);
    for (const bad of ["ab_", "a__b"]) {
      const root = fresh();
      const r = run(["--id", bad, "--name", "X", "--root", root]);
      expect(r.status, bad).toBe(1);
      expect(listFiles(root)).toEqual([]);
    }
    // Hvelvreferansen som genereres for en lovlig id følger hvelvreferanse-formen (STORE bokstaver, enkle understreker): JARVIS_<ID>_TOKEN.
    const VAULT_REF = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
    for (const good of ["a_b", "ab", "a1_b2", "google_sheets"]) expect(VAULT_REF.test(`JARVIS_${good.toUpperCase()}_TOKEN`), good).toBe(true);
  });

  it("usynlige og retningsstyrende tegn i --name/--vendor avvises (nullbredde, bidi, U+2028/U+2029/U+0085, BOM, formattegn) - ingen injeksjon, men heller ingen skjulte tegn i genererte filer", () => {
    const hidden = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0x2028, 0x2029, 0x0085, 0xfeff, 0x00ad, 0x061c, 0xe000].map((cp) => String.fromCodePoint(cp));
    for (const ch of hidden) {
      expect(() => normalize({ id: "acme_x", name: `Acme${ch}Tasks`, write: false }), `U+${ch.codePointAt(0).toString(16)}`).toThrow(GeneratorError);
      expect(() => normalize({ id: "acme_x", name: "Acme", vendor: `Ven${ch}dor`, write: false })).toThrow(GeneratorError);
    }
    const root = fresh();
    expect(run(["--id", "acme_x", "--name", `A${String.fromCodePoint(0x202e)}B`, "--root", root]).status).toBe(1);
    expect(listFiles(root)).toEqual([]);
    // Vanlig tekst (norske bokstaver, mellomrom, bindestrek, punktum, parentes, &) er fortsatt lovlig.
    expect(normalize({ id: "acme_x", name: "Åse & Øvre (v2) - AS.", vendor: "Blåbær Ægir", write: false }).name).toBe("Åse & Øvre (v2) - AS.");
  });
});

describe("review N4/N7: ingen ekko av argumenter eller unntakstekst, ingen token-formede navn, ingen tom fil etter en feilet skriving, klar melding for dinglende --root", () => {
  /** Token-formede verdier bygges ved KJØRING (aldri som bokstaver i kilden, så gitleaks aldri ser dem). `ghp_...` med små bokstaver er en gyldig snake_case-id. */
  const githubShaped = () => `ghp_${"a1".repeat(18)}`;
  const stripeShaped = () => `sk_live_${"c3".repeat(12)}`;
  const tree = (root) => (existsSync(root) ? readdirSync(root, { recursive: true }).map((p) => String(p).split("\\").join("/")).sort() : []);

  it("N4: et ukjent argument ekkoes ALDRI (kun plassering og lengde) - også når det er et helt token", () => {
    const token = githubShaped();
    for (const argv of [[token], ["--id", "acme_x", "--name", "Acme", token], ["--id", "acme_x", "--name", "Acme", `--${token}`]]) {
      const out = [];
      const code = main(argv, { log: () => {}, err: (s) => out.push(s) });
      const text = out.join("\n");
      expect(code, argv.join(" ")).toBe(1);
      expect(text).toMatch(/ukjent argument nr\. \d+ \(\d+ tegn\)/);
      for (const leak of [token, token.slice(0, 8), token.slice(0, 4)]) expect(text.includes(leak), leak).toBe(false);
    }
    expect(() => parseArgs([githubShaped()])).toThrow(/ukjent argument nr\. 1 \(40 tegn\)/);
  });

  it("N4: et uventet unntak viser kun navn/kode - aldri meldingen (token i meldingen, in-process og som kommando)", () => {
    const token = githubShaped();
    const out = [];
    const throwing = { log: () => { throw new Error(`log feilet for ${token}`); }, err: (s) => out.push(s) };
    expect(main(["--id", "acme_x", "--name", "Acme", "--dry-run"], throwing)).toBe(1);
    expect(out).toEqual(["UVENTET FEIL: Error"]);
    // Som kommando: en mal som er en MAPPE gir EISDIR (en rå feilmelding ville vist en systemtekst); utdata er bare navn og kode.
    const root = fresh();
    const templates = fresh();
    for (const name of ["manifest.ts.tmpl", "fake-adapter.ts.tmpl", "contract.test.ts.tmpl", "runbook.md.tmpl"]) mkdirSync(join(templates, name));
    const r = run(["--id", "acme_x", "--name", "Acme", "--templates", templates, "--root", root]);
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe("UVENTET FEIL: Error (EISDIR)");
    expect(listFiles(root)).toEqual([]);
  });

  it("N4: errorLabel slipper bare allowlistede former (navn: bokstaver/tall, kode: STORE bokstaver/tall/_) og redigerer en token-formet del", () => {
    expect(errorLabel(new Error("m"))).toBe("Error");
    expect(errorLabel(Object.assign(new TypeError("m"), { code: "ERR_X" }))).toBe("TypeError (ERR_X)");
    expect(errorLabel(Object.assign(new Error("m"), { code: githubShaped() }))).toBe("Error");
    expect(errorLabel(Object.assign(new Error("m"), { name: githubShaped() }))).toBe("Error");
    const awsShaped = `AKIA${"B7".repeat(8)}`;
    expect(errorLabel(Object.assign(new Error("m"), { name: awsShaped }))).toBe("[REDACTED:aws_access_key]");
    for (const odd of ["streng", 3, undefined, null, {}]) expect(errorLabel(odd), String(odd)).toBe("Error");
  });

  it("N7: en token-formet --id, --name, --vendor og --tool-id (også med små bokstaver) avvises (kode 1) uten å skrive noe og uten å ekkoe verdien - kun funn-typen", () => {
    for (const [flag, make] of [["--id", githubShaped], ["--id", stripeShaped], ["--name", githubShaped], ["--vendor", githubShaped], ["--tool-id", stripeShaped]]) {
      const value = make();
      const base = ["--id", "acme_x", "--name", "Acme"].filter((x, i, a) => !(a[i - 1] === flag || x === flag));
      const root = fresh();
      const r = run([...base, flag, value, "--root", root]);
      expect(r.status, `${flag} ${value.slice(0, 6)}`).toBe(1);
      expect(r.stderr).toContain(`${flag} ligner en hemmelighet`);
      expect(r.stderr).toMatch(/\((github_token|stripe_key)\)/);
      for (const leak of [value, value.slice(0, 8)]) expect(r.stderr.includes(leak), `${flag}: ${leak}`).toBe(false);
      expect(listFiles(root)).toEqual([]);
    }
    // Også ved tørrkjøring (valideringen skjer før noe planlegges), og via normalize() direkte:
    expect(main(["--id", githubShaped(), "--name", "X", "--dry-run"], quiet)).toBe(1);
    expect(() => normalize({ id: githubShaped(), name: "X", write: false })).toThrow(GeneratorError);
    expect(() => normalize({ id: "acme_x", name: `API_KEY=${"x7".repeat(8)}`, write: false })).toThrow(/named_secret/);
  });

  it("N7: vanlige navn og id-er (inkl. alle eksemplene i dokumentasjonen) har ingen funn - ingen falske positive for normal bruk", () => {
    for (const v of ["acme_tasks", "google_sheets", "a_b", "ab", "x9", "zz_demo", "tasks-api", "Acme Tasks", "Åse & Øvre (v2) - AS.", "Acme Corp"]) expect(secretKinds(v), v).toEqual([]);
  });

  it("N7: en feilet skriving ETTER at filen er opprettet (disk full) etterlater ingen tom fil og ingen mapper - alt denne kjøringen laget fjernes", () => {
    const plan = planFiles(normalize({ id: "acme_x", name: "Acme", write: false }));
    for (const failOn of [1, 2, 4]) {
      const root = fresh();
      let n = 0;
      const io = { openSync, closeSync, writeFileSync: (...a) => { n += 1; if (n === failOn) throw Object.assign(new Error("simulert disk full"), { code: "ENOSPC" }); return writeFileSync(...a); } };
      let caught;
      try { writePlan(root, plan, { io }); } catch (e) { caught = e; }
      expect(caught?.code, `feiler på fil ${failOn}`).toBe("ENOSPC");
      expect(tree(root), `feiler på fil ${failOn}`).toEqual([]);
    }
    // Kontroll: uten feil skrives alle fire.
    const ok = fresh();
    expect(writePlan(ok, plan).length).toBe(4);
    expect(listFiles(ok).length).toBe(4);
  });

  it("N7: en fil som dukker opp underveis (EEXIST ved åpning) er IKKE vår: den røres ikke, det kjøringen selv laget før den fjernes (kode 2)", () => {
    const plan = planFiles(normalize({ id: "acme_x", name: "Acme", write: false }));
    const root = fresh();
    const intruder = join(root, plan[1].path);
    const io = {
      openSync: (path, flag) => {
        if (path === intruder) { mkdirSync(dirname(intruder), { recursive: true }); writeFileSync(intruder, "annens fil\n"); }
        return openSync(path, flag);
      },
      closeSync, writeFileSync
    };
    let caught;
    try { writePlan(root, plan, { io }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GeneratorError);
    expect(caught.exitCode).toBe(2);
    expect(readFileSync(intruder, "utf8")).toBe("annens fil\n");
    expect(listFiles(root)).toEqual([plan[1].path]);
  });

  it("N7: en dinglende symlenke som --root gir en KLAR melding (kode 1, uten rå ENOENT/UVENTET og uten å ekkoe stien), også ved tørrkjøring, og ingenting dukker opp i målet", () => {
    const holder = fresh();
    const target = join(holder, "finnes-ikke");
    const link = join(holder, "rot");
    symlinkSync(target, link);
    for (const extra of [[], ["--dry-run"]]) {
      const r = run(["--id", "acme_x", "--name", "Acme", "--root", link, ...extra]);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain("dinglende symlenke");
      expect(r.stderr).not.toMatch(/ENOENT|EEXIST|UVENTET/);
      expect(r.stderr.includes(link)).toBe(false);
    }
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
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
