import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASELINE_ORIGIN } from "../src/program/baseline-origin.ts";
import { bumpVersion, refreshFingerprints } from "../src/program/fingerprint-tool.ts";
import { ProgramDataError, collectRepoFacts, loadProgramData, makeFileReader, parseComposeServiceNames } from "../src/program/fs-loader.ts";
import { canonicalizeShard, serializeData } from "../src/program/index-builder.ts";
import { formatReport, runProgramIndex } from "../src/program/run.ts";
import { manifest, shard, T0 } from "./program-index-fixtures.ts";
import { A_TS, json, miniRepo, put, tmp } from "./program-index-minirepo.ts";

/**
 * WP-PGA / PG1: lasteren og orkestratoren mot et ekte (midlertidig) filtre. Dekker sharding (én fil per komponent), deterministisk sammenslåing, avvisning av løse filer/symlenker/for store filer,
 * repo-fakta (migrasjoner, compose, kontraktfiler, pakker), stibeskyttelse og fingeravtrykk-verktøyet (tørrkjøring og skriving).
 */

const run = (root: string, env: string | undefined = undefined, origin: readonly string[] = []) => runProgramIndex({ root, env, origin });

describe("ren mini-repo", () => {
  it("gir null funn, ok dom, riktige tellinger og alle porter OPEN", () => {
    const { root } = miniRepo();
    const r = run(root);
    expect(r.findings).toEqual([]);
    expect(r.verdict).toEqual({ ok: true, failures: [] });
    expect(r.counts).toMatchObject({ components_total: 3, components_built: 2, components_planned: 1, tables_total: 2, tables_owned: 2, workspace_dirs: 2, workspace_dirs_covered: 2, migrations_total: 2, migrations_claimed: 2, services_total: 1, services_owned: 1 });
    expect(r.counts.gates_effective).toEqual({ OPEN: 17, PASS: 0, FAIL: 0 });
    expect(r.counts.orls_effective).toEqual({ OPEN: 6, PASS: 0, FAIL: 0 });
    expect(r.mode).toMatchObject({ mode: "report", manifest_mode: "report", env_mode: null });
  });

  it("er deterministisk: samme innhold gir samme digest, uavhengig av rekkefølgen på mengde-lister i en skjerv; endret innhold gir en annen", () => {
    const a = miniRepo();
    const b = miniRepo();
    const original = run(a.root).index.digest;
    expect(run(b.root).index.digest).toBe(original);
    // Samme komponent, tabellene oppgitt i omvendt rekkefølge i filen.
    const file = join(b.root, "config/program/components/core.alpha.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof shard>;
    data.state_store.migrations = ["001_a.sql"];
    data.code_paths = ["modules/alpha"];
    data.risk.memory_spaces = ["shared", "personal"];
    writeFileSync(file, json(data));
    const reordered = run(b.root).index.digest;
    data.risk.memory_spaces = ["personal", "shared"];
    writeFileSync(file, json(data));
    expect(run(b.root).index.digest).toBe(reordered);
    // Et ekte innholdsskifte endrer digesten.
    data.title = "Annen tittel";
    writeFileSync(file, json(data));
    expect(run(b.root).index.digest).not.toBe(reordered);
  });

  it("indeksen inneholder komponentene sortert på id, og den sammenslåtte formen har fast formatmerke", () => {
    const { root } = miniRepo();
    const r = run(root);
    expect(r.index.format).toBe("program-index/1");
    expect(r.index.components.map((c) => c.component_id)).toEqual(["ci.gamma", "core.alpha", "core.beta"]);
    expect(r.index.gates.length).toBe(17);
    expect(r.index.orls.length).toBe(6);
  });

  it("rapporten viser tallene og domen", () => {
    const { root } = miniRepo();
    const text = formatReport(run(root));
    expect(text).toContain("3 komponenter (2 bygd, 1 planlagt)");
    expect(text).toContain("2/2 tabeller");
    expect(text).toContain("Modus: report");
    expect(text).toContain("Funn: 0");
    expect(text).toContain("Dom: OK");
  });
});

describe("lasting: ugyldige og løse filer blir funn, ikke stille hopp", () => {
  it("en ugyldig skjerv (JSON/skjema) gir data_invalid og utelates, resten skannes videre", () => {
    const { root } = miniRepo();
    put(root, "config/program/components/bad.json", "{ ikke json");
    put(root, "config/program/components/core.worse.json", json({ ...shard("core.worse"), extra: 1 }));
    const r = run(root);
    expect(r.findings.map((f) => f.id)).toEqual(["data_invalid:config/program/components/bad.json", "data_invalid:config/program/components/core.worse.json"]);
    expect(r.counts.components_total).toBe(3);
  });

  it("filnavn som ikke er <component_id>.json = shard_filename_mismatch (komponenten utelates)", () => {
    const { root } = miniRepo();
    put(root, "config/program/components/other-name.json", json(shard("core.delta", { code_paths: ["modules/alpha/delta"] })));
    const r = run(root);
    expect(r.findings.map((f) => f.id)).toEqual(["shard_filename_mismatch:config/program/components/other-name.json"]);
    expect(r.counts.components_total).toBe(3);
  });

  it("løse filer og mapper i dataene er stray_file", () => {
    const { root } = miniRepo();
    put(root, "config/program/components/README.md", "notater");
    mkdirSync(join(root, "config/program/gates/undermappe"));
    put(root, "config/program/orl/.DS_Store", "x");
    const ids = run(root).findings.map((f) => f.id);
    expect(ids).toEqual(["stray_file:config/program/components/README.md", "stray_file:config/program/gates/undermappe", "stray_file:config/program/orl/.DS_Store"]);
  });

  it("en symlenke i dataene avvises (den kan peke ut av repoet)", () => {
    const { root } = miniRepo();
    put(root, "outside.json", json(shard("core.linked")));
    symlinkSync(join(root, "outside.json"), join(root, "config/program/components/core.linked.json"));
    expect(run(root).findings.map((f) => f.id)).toEqual(["stray_file:config/program/components/core.linked.json"]);
  });

  it("en for stor JSON-fil avvises uten å leses", () => {
    const { root } = miniRepo();
    put(root, "config/program/components/core.huge.json", ` ${" ".repeat(1_100_000)}{}`);
    const f = run(root).findings;
    expect(f.map((x) => x.id)).toEqual(["data_invalid:config/program/components/core.huge.json"]);
    expect(f[0]?.message).toContain("over");
  });

  it("manglende datamappe gir data_invalid for mappen", () => {
    const { root } = miniRepo();
    // fjern orl-mappen ved å gjenskape repoet uten den: bruker en ny rot der orl ikke skrives
    const other = tmp();
    for (const rel of ["config/program/manifest.json", "config/program/baseline.json"]) put(other, rel, readFileSync(join(root, rel), "utf8"));
    put(other, "config/program/components/core.alpha.json", readFileSync(join(root, "config/program/components/core.alpha.json"), "utf8"));
    const data = loadProgramData(other);
    expect(data.findings.map((f) => f.id)).toEqual(["data_invalid:config/program/gates", "data_invalid:config/program/orl"]);
  });

  it("ugyldig manifest eller baseline stopper hele kjøringen (ProgramDataError), aldri en stille standard", () => {
    const a = miniRepo();
    put(a.root, "config/program/manifest.json", json({ schema_version: "1.0.0", guard: { mode: "warn" } }));
    expect(() => run(a.root)).toThrow(ProgramDataError);
    const b = miniRepo();
    put(b.root, "config/program/baseline.json", "{}");
    expect(() => run(b.root)).toThrow(ProgramDataError);
    const c = miniRepo();
    put(c.root, "config/program/manifest.json", "ikke json");
    expect(() => run(c.root)).toThrow(/manifest_invalid/);
  });
});

describe("modus og baseline gjennom orkestratoren", () => {
  const withOrphan = (): string => {
    const { root } = miniRepo();
    put(root, "db/003_c.sql", "CREATE TABLE t_orphan (a int);\n");
    return root;
  };

  it("et nytt funn: ok i report, rødt i enforce (manifest) og rødt når miljøet hever til enforce", () => {
    const root = withOrphan();
    const r = run(root);
    expect(r.findings.map((f) => f.id)).toEqual(["migration_unclaimed:003_c.sql", "table_orphan:t_orphan"]);
    expect(r.verdict.ok).toBe(true);
    const raised = run(root, "enforce");
    expect(raised.verdict.ok).toBe(false);
    expect(raised.mode).toMatchObject({ mode: "enforce", raised_by_env: true });
    expect(formatReport(raised)).toContain("Dom: RØD");
    const manifestFile = join(root, "config/program/manifest.json");
    const m = JSON.parse(readFileSync(manifestFile, "utf8")) as ReturnType<typeof manifest>;
    m.guard.mode = "enforce";
    writeFileSync(manifestFile, json(m));
    expect(run(root).verdict.ok).toBe(false);
    // miljøet kan ikke løse opp et enforce-manifest
    expect(run(root, "report").verdict.ok).toBe(false);
  });

  it("kjente funn i baselinen (og origin) feller ikke i enforce; en foreldet oppføring og vekst feller i begge moduser", () => {
    const root = withOrphan();
    const entry = (id: string) => ({ id, reason: "Kjent brudd i påvente av en eierbeslutning.", since: "2026-11-26", decision_ref: null });
    const known = ["migration_unclaimed:003_c.sql", "table_orphan:t_orphan"];
    put(root, "config/program/baseline.json", json({ schema_version: "1.0.0", entries: known.map(entry) }));
    const ok = run(root, "enforce", known);
    expect(ok.baseline.known_findings.length).toBe(2);
    expect(ok.verdict.ok).toBe(true);
    // vekst: origin har ikke oppføringen
    expect(run(root, undefined, [known[0] as string]).verdict.ok).toBe(false);
    // foreldet: oppføring uten funn
    put(root, "config/program/baseline.json", json({ schema_version: "1.0.0", entries: [...known, "service_orphan:ghost"].map(entry) }));
    const stale = run(root, undefined, [...known, "service_orphan:ghost"]);
    expect(stale.baseline.stale_entries).toEqual(["service_orphan:ghost"]);
    expect(stale.verdict.ok).toBe(false);
  });

  it("den frosne origin-listen i kilden er tom (første fyll etterlot ingen kjente brudd) og uforanderlig", () => {
    expect([...BASELINE_ORIGIN]).toEqual([]);
    expect(Object.isFrozen(BASELINE_ORIGIN)).toBe(true);
  });
});

describe("repo-fakta og stibeskyttelse", () => {
  it("migrasjoner, kataloger, compose, kontraktfiler og pakker leses; node_modules/dot-mapper og .d.ts ignoreres; kun workspace:-avhengigheter teller", () => {
    const { root } = miniRepo();
    mkdirSync(join(root, "modules/node_modules"), { recursive: true });
    mkdirSync(join(root, "modules/.cache"), { recursive: true });
    put(root, "contracts/types.d.ts", "export {};\n");
    put(root, "contracts/sub/inner.ts", "export {};\n");
    put(root, "contracts/notes.md", "x");
    const data = loadProgramData(root);
    const facts = collectRepoFacts(root, data.manifest);
    expect([...facts.tables.keys()].sort()).toEqual(["t_a", "t_b"]);
    expect(facts.migration_files).toEqual(["001_a.sql", "002_b.sql"]);
    expect(facts.workspace_dirs).toEqual(["modules/alpha", "modules/beta"]);
    expect(facts.compose_services).toEqual(["svc"]);
    expect(facts.contract_files).toEqual(["contracts/a.ts"]);
    expect(facts.workspace_packages.find((p) => p.dir === "modules/alpha")).toEqual({ dir: "modules/alpha", name: "@jarvis/alpha", workspace_deps: ["@jarvis/beta"] });
  });

  it("makeFileReader: eksistens, hash (LF-normalisert) og stibeskyttelse", () => {
    const { root } = miniRepo();
    put(root, "crlf.txt", "a\r\nb\r\n");
    put(root, "lf.txt", "a\nb\n");
    const r = makeFileReader(root);
    expect(r.path_exists("contracts/a.ts")).toBe(true);
    expect(r.path_exists("contracts")).toBe(true);
    expect(r.path_exists("contracts/ghost.ts")).toBe(false);
    expect(r.path_exists("../etc/passwd")).toBe(false);
    expect(r.path_exists("/etc/passwd")).toBe(false);
    expect(r.file_sha256("crlf.txt")).toBe(r.file_sha256("lf.txt"));
    expect(r.file_sha256("contracts")).toBeNull();
    expect(r.file_sha256("../x")).toBeNull();
    expect(r.file_sha256("/etc/passwd")).toBeNull();
    expect(r.file_sha256("ghost")).toBeNull();
    symlinkSync(join(root, "contracts/a.ts"), join(root, "link.ts"));
    expect(r.file_sha256("link.ts")).toBeNull();
  });

  it("makeFileReader: en sti som rømmer rota (..) nektes selv når målfilen FINNES utenfor rota", () => {
    const { root } = miniRepo();
    const outside = `utenfor-${process.pid}-${Date.now()}.txt`;
    put(root, `../${outside}`, "finnes\n");
    const r = makeFileReader(root);
    expect(r.path_exists(`../${outside}`)).toBe(false);
    expect(r.file_sha256(`../${outside}`)).toBeNull();
    expect(r.path_exists(`contracts/../../${outside}`)).toBe(false);
    expect(r.file_sha256(`contracts/../../${outside}`)).toBeNull();
  });

  it("beslutningslogg: kun nøyaktige rader `| D-n |`; id-er med regex-tegn finnes aldri", () => {
    const { root } = miniRepo();
    const r = makeFileReader(root);
    expect(r.decision_exists("D-1")).toBe(true);
    expect(r.decision_exists("D-3")).toBe(false);
    expect(r.decision_exists("D-1.*")).toBe(false);
    expect(r.decision_exists("D-")).toBe(false);
    expect(r.decision_exists("D-PROG-01")).toBe(false);
    expect(makeFileReader(tmp()).decision_exists("D-1")).toBe(false);
  });

  it("compose: nøklene rett under services:, ikke ankere, x-nøkler, volumes eller kommentarer", () => {
    expect(parseComposeServiceNames("x-a:\n  b: 1\nservices:\n  one:\n    image: x\n  # two:\n  three: # kommentar\n    image: y\nvolumes:\n  four:\n")).toEqual(["one", "three"]);
    expect(parseComposeServiceNames("name: x\n")).toEqual([]);
    expect(parseComposeServiceNames("services:\r\n  a:\r\n    image: x\r\n")).toEqual(["a"]);
  });
});

describe("fingerprint-verktøyet (PGA-D-07)", () => {
  const NOW = "2026-12-01T08:00:00.000Z";
  const alphaFile = (root: string) => join(root, "config/program/components/core.alpha.json");
  const readAlpha = (root: string) => JSON.parse(readFileSync(alphaFile(root), "utf8")) as ReturnType<typeof shard>;

  it("uendrede filer gir ingen endring; en endret kontraktfil gir mismatch i skanningen og en avvikende nyhash i tørrkjøringen (uten å skrive)", () => {
    const { root } = miniRepo();
    expect(refreshFingerprints(root, { write: false, now: NOW })).toMatchObject([{ component_id: "core.alpha", changed: false, written: false, problem: null }]);
    put(root, "contracts/a.ts", "export const a = 2;\n");
    expect(run(root).findings.map((f) => f.id)).toEqual(["contract_fingerprint_mismatch:core.alpha"]);
    const dry = refreshFingerprints(root, { write: false, now: NOW });
    expect(dry[0]).toMatchObject({ changed: true, written: false });
    expect(dry[0]?.after).not.toBe(dry[0]?.before);
    expect(readAlpha(root).contract.changed_at).toBe(T0);
  });

  it("--write oppdaterer fingeravtrykk og changed_at (kun ved endring), bumper versjonen, skriver kanonisk JSON og gir deretter en ren skanning", () => {
    const { root } = miniRepo();
    put(root, "contracts/a.ts", "export const a = 2;\n");
    const out = refreshFingerprints(root, { write: true, bump: "minor", now: NOW });
    expect(out[0]).toMatchObject({ component_id: "core.alpha", changed: true, written: true, version_before: "0.1.0", version_after: "0.2.0", problem: null });
    const alpha = readAlpha(root);
    expect(alpha.contract.changed_at).toBe(NOW);
    expect(alpha.contract.version).toBe("0.2.0");
    expect(readFileSync(alphaFile(root), "utf8")).toBe(serializeData(canonicalizeShard(alpha)));
    expect(run(root).findings).toEqual([]);
    // kjøres igjen: ingenting endres, changed_at står
    const again = refreshFingerprints(root, { write: true, bump: "minor", now: "2027-01-01T00:00:00.000Z" });
    expect(again[0]).toMatchObject({ changed: false, written: false, version_after: "0.2.0" });
    expect(again[0]?.problem).toContain("ingen kontraktendring");
    expect(readAlpha(root).contract.changed_at).toBe(NOW);
  });

  it("uten --bump røres versjonen ikke; patch og major bumper riktig", () => {
    const { root } = miniRepo();
    put(root, "contracts/a.ts", "export const a = 3;\n");
    refreshFingerprints(root, { write: true, now: NOW });
    expect(readAlpha(root).contract.version).toBe("0.1.0");
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    expect(bumpVersion("x", "patch")).toBeNull();
  });

  it("manglende kontraktfil: ingenting skrives og problemet navngis", () => {
    const { root } = miniRepo();
    const before = readFileSync(alphaFile(root), "utf8");
    unlinkSync(join(root, "contracts/a.ts"));
    const out = refreshFingerprints(root, { write: true, bump: "patch", now: NOW });
    expect(out[0]).toMatchObject({ component_id: "core.alpha", changed: false, written: false });
    expect(out[0]?.problem).toContain("kontraktfiler mangler eller kan ikke leses: contracts/a.ts");
    expect(readFileSync(alphaFile(root), "utf8")).toBe(before);
  });

  it("ukjent komponent og komponent uten kontraktfiler gir et navngitt problem (ingen skriving)", () => {
    const { root } = miniRepo();
    const out = refreshFingerprints(root, { ids: ["core.nope", "core.beta"], write: true, now: NOW });
    expect(out.map((m) => [m.component_id, m.problem])).toEqual([
      ["core.beta", "komponenten har ingen kontraktfiler"],
      ["core.nope", "ukjent komponent"]
    ]);
  });

  it("en kontraktfil som er symlenke kan ikke bevises (ingen skriving)", () => {
    const { root } = miniRepo();
    put(root, "contracts/real.ts", A_TS);
    unlinkSync(join(root, "contracts/a.ts"));
    symlinkSync(join(root, "contracts/real.ts"), join(root, "contracts/a.ts"));
    const out = refreshFingerprints(root, { write: true, now: NOW });
    expect(out[0]?.problem).toContain("kan ikke leses");
    expect(out[0]?.written).toBe(false);
  });
});
