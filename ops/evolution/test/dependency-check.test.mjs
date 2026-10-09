import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDependencyChanges, isDirectRun, renderDependencyCheckNo } from "../dependency-check.ts";
import { classifySpec, evaluateDependencyChange, lookalikes } from "../../../modules/self-modification/src/evolution/supply-chain.ts";

/** WP-B (D-452), EV-7: avhengighetsporten som skript. Ren sammenligning + ekte git-integrasjon i et midlertidig repo. */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/evolution/dependency-check.ts");
const pkg = (deps = {}, scripts = {}) => ({ name: "x", dependencies: deps, scripts });

describe("checkDependencyChanges", () => {
  it("ingen endring → E0 og ok", () => {
    const r = checkDependencyChanges({ "package.json": pkg({ zod: "^3.25.76" }) }, { "package.json": pkg({ zod: "^3.25.76" }) });
    expect(r).toMatchObject({ ok: true, change_class: "E0", changed: [] });
    expect(renderDependencyCheckNo(r)).toBe("Ingen avhengighetsendringer.");
  });

  it("enhver avhengighetsendring er E2 (eier-godkjenning), men ikke avvist uten mistanke", () => {
    const r = checkDependencyChanges({ "modules/a/package.json": pkg({ zod: "^3.0.0" }) }, { "modules/a/package.json": pkg({ zod: "^3.25.0", pg: "^8.16.3" }) });
    expect(r.change_class).toBe("E2");
    expect(r.ok).toBe(true);
    expect(r.changed[0].verdict.added).toEqual(["pg"]);
    expect(r.changed[0].verdict.version_changed).toEqual(["zod"]);
    expect(renderDependencyCheckNo(r)).toContain("klasse E2");
  });

  it("typosquat-mistanke avviser (ok=false) og nevner filen; en ny pakkefil er alle avhengigheter nye", () => {
    const r = checkDependencyChanges({}, { "modules/new/package.json": pkg({ lodsh: "^4.17.21", zod: "^3.25.0" }) });
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual(["modules/new/package.json"]);
    expect(renderDependencyCheckNo(r)).toContain("possible_typosquat:lodsh~lodash");
    expect(renderDependencyCheckNo(r)).toContain("AVVIST");
  });

  it("pakker fra git/url og endrede install-skript flagges", () => {
    const r = checkDependencyChanges({ "package.json": pkg({}) }, { "package.json": pkg({ evil: "github:someone/evil" }, { postinstall: "node run.js" }) });
    const flags = r.changed[0].verdict.flags.join(",");
    expect(flags).toContain("non_registry_source:evil");
    expect(flags).toContain("install_script_changed:postinstall");
  });
});

describe("skriptet mot et ekte git-repo", () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "dep-check-"));
    const run = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    mkdirSync(join(dir, "modules/a"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg({ zod: "^3.25.0" })));
    writeFileSync(join(dir, "modules/a/package.json"), JSON.stringify(pkg({ pg: "^8.16.3" })));
    run("add", "-A");
    run("commit", "-q", "-m", "base");
    return dir;
  }
  const node = (dir, ...args) => spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", SCRIPT, "--cwd", dir, "--base", "HEAD", ...args], { encoding: "utf8" });

  it("uendret arbeidstre → exit 0 og «Ingen avhengighetsendringer»", () => {
    const r = node(repo());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Ingen avhengighetsendringer.");
  });

  it("ny avhengighet → exit 0 med E2-rapport; typosquat → exit 1", () => {
    const dir = repo();
    writeFileSync(join(dir, "modules/a/package.json"), JSON.stringify(pkg({ pg: "^8.16.3", dotenv: "^16.0.0" })));
    const ok = node(dir, "--json");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("klasse E2");
    expect(ok.stdout).toContain('"change_class":"E2"');
    writeFileSync(join(dir, "modules/a/package.json"), JSON.stringify(pkg({ pg: "^8.16.3", expres: "^4.0.0" })));
    const bad = node(dir);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("AVVIST");
  });
});

/**
 * M3 (gjennomgang av PR #313): «enhver avhengighetsendring» hadde hull. a) ikke-ASCII-stinavn ble sitert av git og aldri funnet, b) overrides/resolutions/peer/bundled ble aldri lest, c) typosquat-vakten slapp
 * gjennom scopede lookalikes, avstand 2 og alias, d) ikke-registerkilder ga exit 0, e) kjøring via symlink gjorde ingenting og ga exit 0.
 */
const git = (dir, ...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
/** Et tomt git-repo med en basis-commit av `files` (`sti → innhold`). */
function gitRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "dep-check-m3-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.quotePath", "true"); // standard i git: ikke-ASCII sitert hvis skriptet ikke selv slår det av
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}
function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
  }
}
const cli = (script, dir, ...args) => spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", script, "--cwd", dir, ...args], { encoding: "utf8" });
const json = (r) => JSON.parse(r.stdout.trim().split("\n").at(-1));
const PLAIN = pkg({ zod: "^3.25.0" });
const TYPO = pkg({ zod: "^3.25.0", lodsh: "^4.17.21" });

describe("M3 a: stinavn med ikke-ASCII, mellomrom, anførselstegn og linjeskift", () => {
  const NAMES = ["modules/plain", "modules/ü", "modules/ø å", "modules/mellom rom", 'modules/"anførsel"', "modules/linje\nskift", "modules/日本語"];

  it("en typosquat i hvert av disse stinavnene gir AVVIST og exit 1 - både mellom to commits og i arbeidstreet (før: ü ga «Ingen avhengighetsendringer», exit 0)", () => {
    const dir = gitRepo(Object.fromEntries(NAMES.map((n) => [`${n}/package.json`, PLAIN])));
    write(dir, Object.fromEntries(NAMES.map((n) => [`${n}/package.json`, TYPO])));
    // Arbeidstreet (ikke committet)
    const worktree = cli(SCRIPT, dir, "--base", "HEAD", "--json");
    expect(worktree.status, worktree.stderr).toBe(1);
    expect(json(worktree).rejected.sort()).toEqual(NAMES.map((n) => `${n}/package.json`).sort());
    // Mellom to commits
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "typosquat");
    const commits = cli(SCRIPT, dir, "--base", "HEAD~1", "--head", "HEAD", "--json");
    expect(commits.status, commits.stderr).toBe(1);
    expect(json(commits).rejected.sort()).toEqual(NAMES.map((n) => `${n}/package.json`).sort());
    expect(commits.stdout).toContain("AVVIST");
  });

  it("samme innhold gir samme resultat uansett stinavn: en uskyldig endring i ü rapporteres som E2 med exit 0, ikke som «Ingen avhengighetsendringer»", () => {
    const dir = gitRepo({ "modules/ü/package.json": PLAIN, "modules/plain/package.json": PLAIN });
    write(dir, { "modules/ü/package.json": pkg({ zod: "^3.26.0" }), "modules/plain/package.json": pkg({ zod: "^3.26.0" }) });
    const r = cli(SCRIPT, dir, "--base", "HEAD", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(json(r).changed.map((c) => c.path).sort()).toEqual(["modules/plain/package.json", "modules/ü/package.json"]);
    expect(r.stdout).not.toContain("Ingen avhengighetsendringer");
  });
});

describe("M3 b: alle felt som kan endre hva som installeres er avhengighetsendringer (E2)", () => {
  const base = { name: "x", dependencies: { zod: "^3.25.0" }, pnpm: { overrides: { lodash: "4.17.21" } } };
  const verdict = (after, before = base) => evaluateDependencyChange(before, after);

  it("bytte av pnpm.overrides fra lodash 4.17.21 til npm:evil@1.0.0 er en E2-endring, flagget og avvist som maskerad (før: «Ingen avhengighetsendringer»)", () => {
    const v = verdict({ ...base, pnpm: { overrides: { lodash: "npm:evil@1.0.0" } } });
    expect(v).toMatchObject({ changed: true, change_class: "E2", needs_owner_review: true, proceed_to_owner: false });
    expect(v.version_changed).toEqual(["lodash [pnpm.overrides]"]);
    expect(v.flags).toEqual(expect.arrayContaining(["override_changed:pnpm.overrides:lodash", "alias_to_other_package:lodash->evil", "possible_typosquat:lodash~alias:evil"]));
    const r = checkDependencyChanges({ "package.json": base }, { "package.json": { ...base, pnpm: { overrides: { lodash: "npm:evil@1.0.0" } } } });
    expect(r).toMatchObject({ ok: false, change_class: "E2", exit_code: 1, rejected: ["package.json"] });
  });

  it("hvert av feltene overrides, resolutions, peerDependencies, optionalDependencies, bundledDependencies og pnpm-feltene gir en E2-endring når de endres", () => {
    const cases = {
      "overrides (nøstet)": [{ ...base, overrides: { foo: { bar: "1.0.0" } } }, { ...base, overrides: { foo: { bar: "2.0.0" } } }, "foo>bar [overrides]"],
      "resolutions": [{ ...base, resolutions: { "**/lodash": "4.17.20" } }, { ...base, resolutions: { "**/lodash": "4.17.21" } }, "**/lodash [resolutions]"],
      "peerDependencies (ny)": [base, { ...base, peerDependencies: { react: ">=18" } }, "react [peerDependencies]"],
      "optionalDependencies (endret)": [{ ...base, optionalDependencies: { fsevents: "^2.3.2" } }, { ...base, optionalDependencies: { fsevents: "^2.3.3" } }, "fsevents [optionalDependencies]"],
      "bundledDependencies (liste)": [{ ...base, bundledDependencies: ["a"] }, { ...base, bundledDependencies: ["a", "b"] }, "b [bundledDependencies]"],
      "bundleDependencies: true": [base, { ...base, bundleDependencies: true }, "(alle) [bundledDependencies]"],
      "pnpm.patchedDependencies": [base, { ...base, pnpm: { ...base.pnpm, patchedDependencies: { "zod@3.25.0": "patches/zod.patch" } } }, "zod@3.25.0 [pnpm.patchedDependencies]"],
      "pnpm.onlyBuiltDependencies (utvidet)": [{ ...base, pnpm: { ...base.pnpm, onlyBuiltDependencies: ["esbuild"] } }, { ...base, pnpm: { ...base.pnpm, onlyBuiltDependencies: ["esbuild", "evil-postinstall"] } }, "evil-postinstall [pnpm.onlyBuiltDependencies]"],
      "pnpm.packageExtensions": [base, { ...base, pnpm: { ...base.pnpm, packageExtensions: { "react-dom": { dependencies: { evil: "1.0.0" } } } } }, "react-dom>dependencies>evil [pnpm.packageExtensions]"]
    };
    for (const [label, [before, after, expected]] of Object.entries(cases)) {
      const v = evaluateDependencyChange(before, after);
      expect(v.changed, label).toBe(true);
      expect(v.change_class, label).toBe("E2");
      expect([...v.added, ...v.version_changed], label).toContain(expected);
    }
  });

  it("fjerning er også en endring (E2), men aldri i seg selv mistenkelig; en pakke flyttet mellom seksjoner er en endring", () => {
    const removed = verdict({ name: "x", dependencies: { zod: "^3.25.0" } });
    expect(removed).toMatchObject({ changed: true, change_class: "E2", removed: ["lodash [pnpm.overrides]"], needs_owner_review: false, proceed_to_owner: true });
    const moved = evaluateDependencyChange({ dependencies: { zod: "^3.25.0" } }, { devDependencies: { zod: "^3.25.0" } });
    expect(moved).toMatchObject({ changed: true, removed: ["zod"], added: ["zod [devDependencies]"] });
    expect(evaluateDependencyChange(base, JSON.parse(JSON.stringify(base)))).toMatchObject({ changed: false, change_class: "E0" });
  });

  it("override-/patch-endringer krever alltid eierens oppmerksomhet (exit 1), men er ikke avvist uten typosquat", () => {
    const r = checkDependencyChanges({ "package.json": base }, { "package.json": { ...base, pnpm: { overrides: { lodash: "4.17.22" } } } });
    expect(r).toMatchObject({ ok: true, exit_code: 1, owner_review: ["package.json"], rejected: [] });
    expect(renderDependencyCheckNo(r)).toContain("KREVER EIERENS OPPMERKSOMHET");
  });

  it("en ordinær registerendring (ingen flagg) er E2 med exit 0 - kontrakten er uendret", () => {
    const r = checkDependencyChanges({ "package.json": pkg({ zod: "^3.0.0" }) }, { "package.json": pkg({ zod: "^3.25.0", pg: "^8.16.3" }) });
    expect(r).toMatchObject({ ok: true, change_class: "E2", exit_code: 0, owner_review: [] });
  });
});

describe("M3 c: typosquat-vakten", () => {
  const flagsFor = (deps, section = "dependencies") => evaluateDependencyChange({}, { [section]: deps }).flags.filter((f) => f.startsWith("possible_typosquat"));

  it("et scopet navn hvis uscopede del er et populært navn er en lookalike, med mindre scopet er pakkens kjente (@evil/lodash avvises, @types/lodash ikke)", () => {
    expect(flagsFor({ "@evil/lodash": "^4.17.21" })).toEqual(["possible_typosquat:@evil/lodash~lodash"]);
    expect(flagsFor({ "@evil/lodahs": "^4.17.21" })).toEqual(["possible_typosquat:@evil/lodahs~lodash"]);
    for (const ok of ["@types/lodash", "@types/react", "@types/node", "@types/pg", "@testing-library/react", "@emotion/react"]) expect(flagsFor({ [ok]: "^1.0.0" }), ok).toEqual([]);
    // Et kjent scope unnskylder kun et EXAKT treff - en skrivefeil under @types er fortsatt en skrivefeil.
    expect(flagsFor({ "@types/lodahs": "^1.0.0" })).toEqual(["possible_typosquat:@types/lodahs~lodash"]);
  });

  it("editeringsavstand 2 gjelder for navn på minst 6 tegn (lodahs), 1 for kortere (raect slipper, reakt avvises)", () => {
    expect(flagsFor({ lodahs: "^4.17.21" })).toEqual(["possible_typosquat:lodahs~lodash"]);
    expect(flagsFor({ expres: "^4.0.0" })).toEqual(["possible_typosquat:expres~express"]);
    expect(flagsFor({ reakt: "^18.0.0" })).toEqual(["possible_typosquat:reakt~react"]);
    expect(flagsFor({ raect: "^18.0.0" })).toEqual([]); // avstand 2 men kort navn → kun avstand 1 gjelder
    expect(flagsFor({ zodd: "^3.0.0" })).toEqual(["possible_typosquat:zodd~zod"]);
    expect(flagsFor({ lodash: "^4.17.21", zod: "^3.0.0", chalk: "^5.0.0" })).toEqual([]); // eksakt treff er den ekte pakken
    expect(lookalikes("x".repeat(100_000))).toEqual([]); // lengdeforskjell kutter DP-en: ingen kvadratisk kostnad
  });

  it("alias løses til målnavnet: zod → npm:evil-zod@1.0.0 er et populært navn som installerer en annen pakke (avvist), og et alias til en lookalike avvises på målet", () => {
    const masquerade = evaluateDependencyChange({}, { dependencies: { zod: "npm:evil-zod@1.0.0" } });
    expect(masquerade.flags).toEqual(expect.arrayContaining(["alias_to_other_package:zod->evil-zod", "possible_typosquat:zod~alias:evil-zod"]));
    expect(masquerade.proceed_to_owner).toBe(false);
    const scoped = evaluateDependencyChange({}, { dependencies: { zod: "npm:@evil/zod@1.0.0" } });
    expect(scoped.flags).toEqual(expect.arrayContaining(["possible_typosquat:@evil/zod~zod"]));
    const aliasToTypo = evaluateDependencyChange({}, { dependencies: { "my-lib": "npm:lodahs@1.0.0" } });
    expect(aliasToTypo.flags).toEqual(expect.arrayContaining(["alias_to_other_package:my-lib->lodahs", "possible_typosquat:lodahs~lodash"]));
    // Et alias som endrer en eksisterende (ikke ny) oppføring til en lookalike fanges på målet.
    const changedToTypo = evaluateDependencyChange({ dependencies: { "my-lib": "^1.0.0" } }, { dependencies: { "my-lib": "npm:lodahs@1.0.0" } });
    expect(changedToTypo.flags).toContain("possible_typosquat:lodahs~lodash");
    expect(changedToTypo.proceed_to_owner).toBe(false);
    // Et alias som endrer en eksisterende pakke til en annen er også fanget (endret, ikke ny).
    const swapped = evaluateDependencyChange({ dependencies: { zod: "^3.25.0" } }, { dependencies: { zod: "npm:evil-zod@1.0.0" } });
    expect(swapped).toMatchObject({ version_changed: ["zod"], proceed_to_owner: false });
    // Et harmløst alias (annet navn, ekte populær pakke) er et funn for eieren, ikke en avvisning.
    const harmless = evaluateDependencyChange({}, { dependencies: { "react-18": "npm:react@18.3.1" } });
    expect(harmless).toMatchObject({ proceed_to_owner: true, needs_owner_review: true });
    expect(harmless.flags).toContain("alias_to_other_package:react-18->react");
    // Et alias til seg selv er ikke noe funn.
    expect(evaluateDependencyChange({}, { dependencies: { zod: "npm:zod@^3.25.0" } }).flags).toEqual([]);
  });

  it("workspace-lenker er interne og typosquat-sjekkes ikke (et workspace-pakkenavn kan ligne uten å være et register-navn)", () => {
    expect(evaluateDependencyChange({}, { dependencies: { "@jarvis/next": "workspace:*", expres: "workspace:^" } }).flags).toEqual([]);
  });
});

describe("M3 d: kilder utenfor registeret", () => {
  const REGISTRY = ["^1.2.3", "~1", ">=1 <2 || ^3", "1.x", "*", "latest", "next", "1.0.0-beta.1", "1.2.3-rc.1+build.5", "1.2.3 - 2.0.0", "v1.2.3", "workspace:*", "workspace:^1.0.0", "catalog:", "catalog:default", "npm:zod@^3.25.0", ""];
  const NON_REGISTRY = [
    "git+https://github.com/x/y.git", "git+ssh://git@github.com/x/y.git", "git://github.com/x/y.git", "https://example.com/x.tgz", "http://example.com/x.tgz", "file:../x", "link:../x", "portal:../x", "github:x/y",
    "gitlab:x/y", "bitbucket:x/y", "gist:abc", "x/y", "x/y#semver:^1.0.0", "./local", "../local", "/abs/path", "~/home/pkg", "patch:zod@3.25.0#./p.patch", "git+https://github.com/x/y.git#v1"
  ];

  it("classifySpec er en ALLOWLIST: semver/dist-tag/workspace/catalog/npm er register eller intern, alt annet er en ikke-registerkilde", () => {
    for (const spec of REGISTRY) expect(["registry", "alias", "internal"], JSON.stringify(spec)).toContain(classifySpec(spec));
    for (const spec of NON_REGISTRY) expect(classifySpec(spec), spec).toBe("non_registry");
  });

  it("hver ikke-registerkilde flagges (ny og endret) og gir exit 1 i skriptet; registerkilder gir ingen flagg", () => {
    for (const spec of NON_REGISTRY) {
      const added = evaluateDependencyChange({}, { dependencies: { thing: spec } });
      expect(added.flags, spec).toContain("non_registry_source:thing");
      expect(added.needs_owner_review, spec).toBe(true);
      const changed = evaluateDependencyChange({ dependencies: { thing: "^1.0.0" } }, { dependencies: { thing: spec } });
      expect(changed.flags, `endret → ${spec}`).toContain("non_registry_source:thing");
    }
    for (const spec of REGISTRY.filter((s) => !s.startsWith("npm:"))) expect(evaluateDependencyChange({}, { dependencies: { thing: spec } }).flags.filter((f) => f.startsWith("non_registry")), JSON.stringify(spec)).toEqual([]);
  });

  it("ekte git-repo: git+https-, URL-, file:- og link:-avhengigheter gir exit 1 (før: flagget, men exit 0); en ordinær registerendring gir fortsatt exit 0", () => {
    const dir = gitRepo({ "package.json": PLAIN });
    for (const spec of ["git+https://github.com/x/y.git", "https://example.com/x.tgz", "file:../x", "link:../x"]) {
      write(dir, { "package.json": pkg({ zod: "^3.25.0", thing: spec }) });
      const r = cli(SCRIPT, dir, "--base", "HEAD");
      expect(r.status, `${spec}: ${r.stderr}`).toBe(1);
      expect(r.stdout).toContain("non_registry_source:thing");
      expect(r.stdout).toContain("KREVER EIERENS OPPMERKSOMHET");
      expect(r.stdout).not.toContain("AVVIST (typosquat");
    }
    write(dir, { "package.json": pkg({ zod: "^3.26.0" }) });
    expect(cli(SCRIPT, dir, "--base", "HEAD").status).toBe(0);
  });
});

describe("M3 e: kjøring via symlink og exit-kontrakten", () => {
  it("via symlink gjør skriptet det samme som direkte: rapporterer og gir riktig exit-kode (før: ingenting, exit 0)", () => {
    const dir = gitRepo({ "package.json": PLAIN });
    const linkDir = mkdtempSync(join(tmpdir(), "dep-check-link-"));
    const link = join(linkDir, "dependency-check.ts");
    symlinkSync(SCRIPT, link);
    const clean = cli(link, dir, "--base", "HEAD");
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain("Ingen avhengighetsendringer.");
    write(dir, { "package.json": TYPO });
    const bad = cli(link, dir, "--base", "HEAD");
    expect(bad.status, bad.stderr).toBe(1);
    expect(bad.stdout).toContain("AVVIST");
    // Kjede av symlinker
    const link2 = join(linkDir, "second.ts");
    symlinkSync(link, link2);
    expect(cli(link2, dir, "--base", "HEAD").status).toBe(1);
  });

  it("isDirectRun: sant for filen selv og for en symlink til den, usant for andre filer og uten argv", () => {
    const linkDir = mkdtempSync(join(tmpdir(), "dep-check-link-"));
    const link = join(linkDir, "x.ts");
    symlinkSync(SCRIPT, link);
    expect(isDirectRun(SCRIPT, SCRIPT)).toBe(true);
    expect(isDirectRun(link, SCRIPT)).toBe(true);
    expect(isDirectRun(join(ROOT, "package.json"), SCRIPT)).toBe(false);
    expect(isDirectRun(undefined, SCRIPT)).toBe(false);
    expect(isDirectRun("/finnes/ikke.ts", SCRIPT)).toBe(false);
  });

  it("bruksfeil og svikt gir exit 2 med en tydelig melding på stderr - aldri 0 og aldri 1", () => {
    const dir = gitRepo({ "package.json": PLAIN });
    const notGit = mkdtempSync(join(tmpdir(), "dep-check-nogit-"));
    const cases = [
      ["ukjent flagg", dir, ["--base", "HEAD", "--ukjent"], /ukjent argument/],
      ["manglende verdi", dir, ["--base"], /mangler verdi/],
      ["referanse som ser ut som et flagg", dir, ["--base", "--output=/tmp/x"], /ugyldig git-referanse/],
      ["referanse som er et kort flagg (flagginjeksjon i git)", dir, ["--base", "-p"], /ugyldig git-referanse/],
      ["WORKTREE som base", dir, ["--base", "WORKTREE"], /ugyldig git-referanse/],
      ["referanse med mellomrom", dir, ["--base", "HEAD main"], /ugyldig git-referanse/],
      ["referanse som ikke finnes", dir, ["--base", "finnes-ikke"], /kunne ikke kjøre/],
      ["ikke et git-repo", notGit, ["--base", "HEAD"], /kunne ikke kjøre/],
      ["cwd som ikke finnes", join(notGit, "borte"), ["--base", "HEAD"], /kunne ikke kjøre/]
    ];
    for (const [label, cwd, args, message] of cases) {
      const r = cli(SCRIPT, cwd, ...args);
      expect(r.status, `${label}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, label).toMatch(/^dependency-check: /);
      expect(r.stderr, label).toMatch(message);
    }
    // En package.json med ugyldig form kan ikke vurderes (ikke «ingen endring»).
    write(dir, { "package.json": { name: "x", dependencies: ["zod"] } });
    const bad = cli(SCRIPT, dir, "--base", "HEAD");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("ugyldig package.json");
    expect(bad.stderr).toContain("package.json");
  });

  it("--help gir bruksteksten med exit-kontrakten og sier at skriptet ikke er koblet til CI", () => {
    const r = cli(SCRIPT, process.cwd(), "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 = ingen funn, 1 = funn");
    expect(r.stdout).toContain("2 = bruksfeil");
    expect(r.stdout).toContain("ikke koblet til CI");
  });
});
