import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDependencyChanges, renderDependencyCheckNo } from "../dependency-check.ts";

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
