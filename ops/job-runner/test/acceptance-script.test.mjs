import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_GITHUB_REPO, FORMER_CANONICAL_GITHUB_REPOS, LEGACY_GITHUB_REPOS, PRODUCTION_GITHUB_REPO_NAMES, githubRepoAliasKey } from "../../../packages/contracts/src/github-repo.ts";
import { createHarness, gitSync, syntheticInstallationToken } from "./support/harness.mjs";
import { apiRequest, RUNNER_TOKEN } from "./support/harness.mjs";
import { makeTempDir } from "./support/tmp.mjs";

/**
 * WP-C1: akseptansescriptet (ops/job-runner/acceptance.sh) kjøres av EIER på NAS-en mot ekte Docker. Her testes det som KAN testes uten:
 * syntaks, tørrkjøring, avvisning av farlige/ufullstendige kall (aldri produksjonsrepoet), og hjelpefunksjonene (`api`, `create_job`, `cexec`,
 * `delete_job`, publish-svar) kjørt for ekte mot den EKTE vertstjenesten over Unix-socket (fake docker). Selve Docker-sjekkene (J03-J10, J12-J13)
 * er `NOT VERIFIED` til eieren kjører scriptet.
 */

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/job-runner/acceptance.sh");
const baseEnv = { PATH: process.env["PATH"], HOME: tmpdir(), LANG: "C.UTF-8" };

// ACCEPTANCE_ENV_FILE peker på en fil som ikke finnes: produksjonsvernet leser ellers <repo>/.env (hermetiske tester). Tester av .env-lesingen setter den selv.
const NO_ENV_FILE = join(tmpdir(), "jarvis-acceptance-test-finnes-ikke.env");
// Finnes en UTF-8-locale på maskinen? (bash-mønstre oppfører seg annerledes på ugyldige UTF-8-bytes der; testene under dekker det bare hvis locale finnes.)
const HAS_UTF8_LOCALE = (spawnSync("locale", ["-a"], { encoding: "utf8" }).stdout ?? "").toLowerCase().split("\n").some((l) => l.includes("utf8") || l.includes("utf-8"));
// Finnes `docker compose` (CLI; trenger ingen daemon for `config`)? Da kan .env-tolkingen testes mot compose selv som orakel.
const HAS_DOCKER_COMPOSE = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 20_000 }).status === 0;
const run = (args, env = {}, input) => spawnSync("bash", [SCRIPT, ...args], { env: { ...baseEnv, ACCEPTANCE_ENV_FILE: NO_ENV_FILE, ...env }, encoding: "utf8", input, timeout: 60_000 });
/** Kjører bash som laster scriptet (ACCEPTANCE_SOURCE_ONLY=1) og så et lite testprogram; argv til programmet gis som args ($1...). */
// (argv legges i en array og nullstilles FØR scriptet lastes: scriptets egen argumentløkke avviser ellers dem som «ukjente argumenter».)
const sourced = (program, args = [], env = {}) => spawnSync("bash", ["-c", `ARGS=("$@"); set --\nset -uo pipefail\nsource "${SCRIPT}"\nset -- "\${ARGS[@]}"\n${program}`, "bash", ...args], { env: { ...baseEnv, ACCEPTANCE_SOURCE_ONLY: "1", ACCEPTANCE_ENV_FILE: NO_ENV_FILE, ...env }, encoding: "utf8", timeout: 60_000 });

let harnesses = [];
afterEach(async () => { await Promise.all(harnesses.map((h) => h.close())); harnesses = []; });

async function setup() {
  const h = await createHarness();
  harnesses.push(h);
  const config = join(h.root, "job-runner.json");
  await writeFile(config, JSON.stringify({
    version: 1,
    runner: {
      socket_path: h.socketPath, token_file: h.tokenFile, base_dir: h.baseDir, network: "jarvis-jobs", image: `sha256:${"a".repeat(64)}`,
      allowed_repos: ["owner/repo"], git_credentials: { "owner/repo": { token_file: join(h.root, "git-token-owner__repo") } }
    },
    egress_proxy: { listen_host: "172.30.77.1", listen_port: 3128 }
  }));
  return { h, config };
}

describe("A: syntaks og tørrkjøring", () => {
  it("bash -n er ren; scriptet er kjørbart og starter med set -uo pipefail", async () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    const text = await readFile(SCRIPT, "utf8");
    expect(text.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(text).toContain("set -uo pipefail");
  });

  it("--dry-run lister ALLE sjekkene og kjører ingenting (exit 0; docker/curl/node/systemctl blir aldri kalt)", async () => {
    // Skim-kommandoer FORAN på PATH: hvis tørrkjøringen noen gang kaller dem, skriver de en markørfil og feiler (exit 99).
    const shims = await makeTempDir("wpc1-shims-");
    const marker = join(shims, "ble-kalt");
    for (const name of ["docker", "curl", "node", "systemctl", "sudo", "iptables", "git"]) {
      const p = join(shims, name);
      await writeFile(p, `#!/bin/sh\necho "${name} $*" >> '${marker}'\nexit 99\n`);
      await chmod(p, 0o755);
    }
    const r = run(["--dry-run"], { PATH: `${shims}:${process.env["PATH"]}` });
    expect(r.status).toBe(0);
    await expect(readFile(marker, "utf8")).rejects.toThrow(); // ingen skim-kommando ble kalt
    for (const id of ["J01_filrettigheter", "J02_helse", "J03_container_per_jobb", "J04_docker_inspect", "J05_inne_i_containeren", "J06_ressursgrenser", "J07_nettverk_deny_by_default", "J08_kansellering", "J09_reclaim_etter_krasj", "J10_ttl", "J11_ende_til_ende_publish", "J12_logger_uten_hemmeligheter", "J13_live_claude", "M01_github_beskyttelse"]) {
      expect(r.stdout, id).toContain(id);
    }
  });

  it("ukjent argument avvises med exit 2; --help skriver bruk", () => {
    expect(run(["--rm-rf"]).status).toBe(2);
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("ACCEPTANCE_REPO");
  });
});

describe("B: avviser farlige/ufullstendige kall FØR noe røres", () => {
  it("uten ACCEPTANCE_REPO (aldri et stille standardrepo) -> exit 2", async () => {
    const { config } = await setup();
    const r = run([], { JARVIS_JOB_RUNNER_CONFIG: config });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ACCEPTANCE_REPO er påkrevd");
  });

  it("repo som ikke står i runner.allowed_repos -> exit 2, ingen jobb opprettet; produksjonsrepoet nektes enda tidligere og tydeligere (B-L5)", async () => {
    const { h, config } = await setup();
    const r = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/annet" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("står ikke i runner.allowed_repos");
    const prod = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "tsworkflow/jarvisbuild" });
    expect(prod.status).toBe(2);
    expect(prod.stderr).toContain("PRODUKSJONSREPOET");
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("B-L5: produksjonsrepoet nektes HARDT selv om det står i runner.allowed_repos (også med annen skrivemåte) - exit 2 før noe røres", async () => {
    const h = await createHarness({ slugs: ["tsworkflow/jarvisbuild"] });
    harnesses.push(h);
    const config = join(h.root, "job-runner.json");
    await writeFile(config, JSON.stringify({
      version: 1,
      runner: {
        socket_path: h.socketPath, token_file: h.tokenFile, base_dir: h.baseDir, network: "jarvis-jobs", image: `sha256:${"a".repeat(64)}`,
        allowed_repos: ["tsworkflow/jarvisbuild"], git_credentials: { "tsworkflow/jarvisbuild": { token_file: join(h.root, "git-token-tsworkflow__jarvisbuild") } }
      },
      egress_proxy: { listen_host: "172.30.77.1", listen_port: 3128 }
    }));
    for (const repo of ["tsworkflow/jarvisbuild", "TSWorkflow/JarvisBuild"]) {
      const r = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: repo });
      expect(r.status, repo).toBe(2);
      expect(r.stderr, repo).toContain("PRODUKSJONSREPOET");
    }
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.fake.calls.filter((c) => ["create", "start", "exec", "rm"].includes(c.args[0] ?? "")).length).toBe(0);
  });

  it("D-479 (kontobytte): det NÅVÆRENDE kanoniske repoet, forkets tidligere navn og det gamle nektes HARDT, også med annen skrivemåte og selv om de står i runner.allowed_repos", async () => {
    const prods = [...PRODUCTION_GITHUB_REPO_NAMES];
    // runner.allowed_repos og git_credentials krever små bokstaver (config_invalid:runner.allowed_repos:entry_invalid ellers); ACCEPTANCE_REPO sammenlignes case-uavhengig.
    const lower = prods.map((s) => s.toLowerCase());
    const h = await createHarness({ slugs: lower });
    harnesses.push(h);
    const config = join(h.root, "job-runner.json");
    await writeFile(config, JSON.stringify({
      version: 1,
      runner: {
        socket_path: h.socketPath, token_file: h.tokenFile, base_dir: h.baseDir, network: "jarvis-jobs", image: `sha256:${"a".repeat(64)}`,
        allowed_repos: lower, git_credentials: Object.fromEntries(lower.map((s) => [s, { token_file: join(h.root, `git-token-${s.replace("/", "__")}`) }]))
      },
      egress_proxy: { listen_host: "172.30.77.1", listen_port: 3128 }
    }));
    for (const slug of prods) {
      for (const repo of [slug, slug.toUpperCase(), slug.toLowerCase(), `${slug}.git`, `${slug}/`, `${slug.toUpperCase()}.GIT`, `${slug}.git/`, `${slug}.git.git`, `${slug}/.git`, `${slug}.git/.git/`, ` ${slug} `, `\t${slug}.git\t`]) {
        const r = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: repo });
        expect(r.status, repo).toBe(2);
        expect(r.stderr, repo).toContain("PRODUKSJONSREPOET");
      }
    }
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.fake.calls.filter((c) => ["create", "start", "exec", "rm"].includes(c.args[0] ?? "")).length).toBe(0);
  });

  it("D-479: eierens konfigurerte JARVIS_GITHUB_REPO (hva det enn er etter et senere kontobytte) nektes også som akseptanserepo; et sandbox-repo passerer vernet", async () => {
    const { h, config } = await setup();
    for (const repo of ["acme/prod", "ACME/Prod", "acme/prod.git", "acme/prod/", "acme/prod.git.git", " acme/prod "]) {
      const r = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: repo, JARVIS_GITHUB_REPO: "Acme/PROD" });
      expect(r.status, repo).toBe(2);
      expect(r.stderr, repo).toContain("PRODUKSJONSREPOET");
      expect(r.stderr, repo).toContain("JARVIS_GITHUB_REPO");
    }
    // Selve JARVIS_GITHUB_REPO normaliseres på samme måte (blanke rundt, `.git`-suffiks, `/` på slutten): et alias på begge sider treffer fortsatt.
    for (const configured of [" acme/prod ", "acme/prod.git", "ACME/PROD.GIT/", "acme/prod/"]) {
      const r = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "acme/prod", JARVIS_GITHUB_REPO: configured });
      expect(r.status, configured).toBe(2);
      expect(r.stderr, configured).toContain("PRODUKSJONSREPOET (JARVIS_GITHUB_REPO i miljøet)");
    }
    // Negativ kontroll: et repo som ikke er produksjon (men heller ikke står i allowed_repos) kommer forbi produksjonsvernet og stoppes først av allowed_repos-sjekken.
    const sandbox = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/annet", JARVIS_GITHUB_REPO: "acme/prod" });
    expect(sandbox.status).toBe(2);
    expect(sandbox.stderr).not.toContain("PRODUKSJONSREPOET");
    expect(sandbox.stderr).toContain("står ikke i runner.allowed_repos");
    // Tom/uset JARVIS_GITHUB_REPO nekter ingenting ekstra (tom streng må ikke matche et tomt repo-navn).
    for (const blankValue of ["", "   ", ".git", "/"]) {
      // Verdier som normaliseres til TOM nøkkel nekter ingenting (en tom nøkkel må aldri matche en tom nøkkel): stoppes av allowed_repos-sjekken, ikke av produksjonsvernet.
      const blank = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/annet", JARVIS_GITHUB_REPO: blankValue });
      expect(blank.status, JSON.stringify(blankValue)).toBe(2);
      expect(blank.stderr, JSON.stringify(blankValue)).not.toContain("PRODUKSJONSREPOET");
      expect(blank.stderr, JSON.stringify(blankValue)).toContain("står ikke i runner.allowed_repos");
      // ...og et ACCEPTANCE_REPO som selv normaliseres til tomt navn avvises som ugyldig, fail-closed (aldri «like» et tomt JARVIS_GITHUB_REPO).
      const emptyRepo = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: ".git", JARVIS_GITHUB_REPO: blankValue });
      expect(emptyRepo.status, JSON.stringify(blankValue)).toBe(2);
      expect(emptyRepo.stderr, JSON.stringify(blankValue)).toContain("ikke et gyldig repo-navn");
      expect(emptyRepo.stderr, JSON.stringify(blankValue)).not.toContain("PRODUKSJONSREPOET");
    }
    // Navn som bare ligner (prefiks/suffiks, `.github.io`, `-sandbox`) er IKKE produksjonsrepoer og skal ikke nektes av vernet.
    for (const similar of ["FFrollerskis/jarvis-build-sandbox", "ffrollerskis/jarvis-build2", "tsworkflow/jarvisbuild.github.io", "tsworkflow/jarvisbuild-test"]) {
      const r = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: similar, JARVIS_GITHUB_REPO: "acme/prod" });
      expect(r.status, similar).toBe(2);
      expect(r.stderr, similar).not.toContain("PRODUKSJONSREPOET");
      expect(r.stderr, similar).toContain("står ikke i runner.allowed_repos");
    }
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("D-479: nektelisten i scriptet (PRODUCTION_REPOS) er i takt med kontrakten: kanonisk, forkets tidligere navn og gamle repo, normalisert (leses ved sourcing, ikke ved å skanne teksten)", () => {
    const r = sourced('printf "%s\\n" "${PRODUCTION_REPOS[@]}"');
    expect(r.status, r.stderr).toBe(0);
    const listed = r.stdout.trim().split("\n");
    expect(new Set(listed)).toEqual(new Set(PRODUCTION_GITHUB_REPO_NAMES.map(githubRepoAliasKey)));
    expect(listed.length).toBe(PRODUCTION_GITHUB_REPO_NAMES.length);
    for (const entry of listed) expect(entry, "listen skal være på normalisert form").toBe(githubRepoAliasKey(entry));
    expect(PRODUCTION_GITHUB_REPO_NAMES).toEqual(expect.arrayContaining([CANONICAL_GITHUB_REPO, ...LEGACY_GITHUB_REPOS, ...FORMER_CANONICAL_GITHUB_REPOS]));
  });

  it("D-479: production_repo_reason og alias_key oppfører seg likt som kontrakten (tabell: alle skrivemåter nektes, navn som bare ligner nektes ikke)", () => {
    const inputs = [
      ...PRODUCTION_GITHUB_REPO_NAMES.flatMap((n) => [n, n.toUpperCase(), n.toLowerCase(), `${n}.git`, `${n}/`, `${n}.git/`, `${n}.git.git`, `${n}/.git`, ` ${n} `, `\t${n}\r`, `${n.toUpperCase()}.GIT`]),
      "owner/annet", "owner/repo.github.io", "owner/mitt.git-repo", "owner/gitops", "FFrollerskis/jarvis-build-sandbox", "ffrollerskis/jarvis-build2", "tsworkflow/jarvisbuild-test", "tsworkflow/jarvisbuild.github.io", "ffrollerskis/jarvisbuild-x", ".git", "/", "", "   "
    ];
    const r = sourced('for v in "$@"; do if production_repo_reason "$v" >/dev/null; then echo 1; else echo 0; fi; done', inputs);
    expect(r.status, r.stderr).toBe(0);
    const verdicts = r.stdout.trim().split("\n");
    expect(verdicts.length).toBe(inputs.length);
    const productionKeys = new Set(PRODUCTION_GITHUB_REPO_NAMES.map(githubRepoAliasKey));
    inputs.forEach((input, i) => expect(verdicts[i], JSON.stringify(input)).toBe(productionKeys.has(githubRepoAliasKey(input)) ? "1" : "0"));
    // alias_key i bash = githubRepoAliasKey i TypeScript (samme normalisering).
    const keys = sourced('for v in "$@"; do printf "[%s]\\n" "$(alias_key "$v")"; done', inputs);
    expect(keys.stdout.trim().split("\n")).toEqual(inputs.map((v) => `[${githubRepoAliasKey(v)}]`));
  });

  it("D-479: JARVIS_GITHUB_REPO leses også fra .env (ACCEPTANCE_ENV_FILE): siste forekomst vinner, export/anførselstegn/CR/kommentar håndteres, kommenterte og lignende nøkler ignoreres, manglende fil nekter ingenting ekstra", async () => {
    const dir = await makeTempDir("acc-env");
    const write = async (name, text) => { const f = join(dir, name); await writeFile(f, text); return f; };
    const envOf = (f) => ({ ACCEPTANCE_ENV_FILE: f });
    const deny = (repo, f) => sourced('production_repo_reason "$1"', [repo], envOf(f));
    const plain = await write("plain.env", "JARVIS_GITHUB_REPO=acme/prod\n");
    expect(deny("acme/prod", plain).status).toBe(0);
    expect(deny("acme/prod", plain).stdout).toContain("JARVIS_GITHUB_REPO i .env");
    expect(deny("ACME/Prod.git", plain).status).toBe(0);
    expect(deny("acme/annet", plain).status).toBe(1);
    const messy = await write("messy.env", "FOO=1\r\nJARVIS_GITHUB_REPO=other/first\r\n# JARVIS_GITHUB_REPO=acme/kommentert\nNOT_JARVIS_GITHUB_REPO=acme/lignende\nexport JARVIS_GITHUB_REPO=\"Acme/Prod.git\"  # kommentar\r\n");
    expect(deny("acme/prod", messy).status, "siste forekomst, export, anførselstegn, CR og kommentar").toBe(0);
    for (const notProd of ["other/first", "acme/kommentert", "acme/lignende"]) expect(deny(notProd, messy).status, notProd).toBe(1);
    // Lignende linjer ETTER den ekte: `tail -n 1` og ^-ankeret skal ikke la dem vinne (reviewer B delta N3, mutant N21)
    const lookalikesAfter = await write("lookalikes-after.env", "JARVIS_GITHUB_REPO=acme/prod\n# JARVIS_GITHUB_REPO=tsworkflow/jarvisbuild\nNOT_JARVIS_GITHUB_REPO=tsworkflow/jarvisbuild\nJARVIS_GITHUB_REPO_ANNET=tsworkflow/jarvisbuild\nXJARVIS_GITHUB_REPO=tsworkflow/jarvisbuild\n");
    expect(deny("acme/prod", lookalikesAfter).status, "den ekte linjen vinner over lignende linjer etter den").toBe(0);
    expect(deny("tsworkflow/jarvisbuild", lookalikesAfter).status, "men det gamle repoet er uansett nektet av de faste navnene").toBe(0);
    expect(deny("acme/andre", lookalikesAfter).status).toBe(1);
    const single = await write("single.env", "JARVIS_GITHUB_REPO='acme/prod'\n");
    expect(deny("acme/prod", single).status).toBe(0);
    const unquotedComment = await write("unquoted.env", "JARVIS_GITHUB_REPO=acme/prod # fra eieren\n");
    expect(deny("acme/prod", unquotedComment).status).toBe(0);
    const bom = await write("bom.env", "\uFEFFJARVIS_GITHUB_REPO=acme/prod\n");
    expect(deny("acme/prod", bom).status, "BOM først i filen").toBe(0);
    const spaced = await write("spaced.env", "FOO=1\nJARVIS_GITHUB_REPO = acme/prod\n");
    expect(deny("acme/prod", spaced).status, "blanke rundt =").toBe(0);
    const spacedExport = await write("spaced-export.env", "  export   JARVIS_GITHUB_REPO  =  \"acme/prod\"  # kommentar\n");
    expect(deny("acme/prod", spacedExport).status, "export, blanke og anførselstegn").toBe(0);
    const emptyValue = await write("empty.env", "JARVIS_GITHUB_REPO=\n");
    expect(deny("", emptyValue).status, "tom verdi nekter ikke et tomt navn").toBe(1);
    expect(deny("acme/prod", emptyValue).status).toBe(1);
    expect(deny("acme/prod", join(dir, "finnes-ikke.env")).status, "manglende fil: ingen ekstra nekt").toBe(1);
    // Hele veien: scriptet nekter før noe annet røres (exit 2) når .env peker på repoet.
    const { config } = await setup();
    const r = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "acme/prod", ACCEPTANCE_ENV_FILE: plain });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("PRODUKSJONSREPOET (JARVIS_GITHUB_REPO i .env)");
    const ok = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/annet", ACCEPTANCE_ENV_FILE: plain });
    expect(ok.stderr).not.toContain("PRODUKSJONSREPOET");
  });

  it("D-479: main() normaliserer ACCEPTANCE_REPO med normalize_repo_arg FØR allowed_repos-sammenligningen (ellers avvises eierens kontonavn med store bokstaver som «ikke i allowed_repos»)", async () => {
    const script = await readFile(SCRIPT, "utf8");
    const normalized = script.indexOf('REPO="$(normalize_repo_arg "$REPO")"');
    const allowedCheck = script.indexOf('case ",$ALLOWED," in');
    const guard = script.indexOf('production_repo_reason "$REPO"');
    expect(guard, "vernet kjører først").toBeGreaterThan(-1);
    expect(normalized, "normaliseringen står i main()").toBeGreaterThan(guard);
    expect(allowedCheck, "allowed_repos-sjekken står etter normaliseringen").toBeGreaterThan(normalized);
  });

  it("D-479 (reviewer B delta N1/N2): .env-lesingen er fail-closed der compose ville tolket linjen annerledes (YAML-kolon, interpolasjon), tåler NUL og ikke-UTF-8, og hopper over FIFO/ulesbar fil med advarsel i stedet for å henge", async () => {
    const dir = await makeTempDir("acc-env2");
    const write = async (name, data) => { const f = join(dir, name); await writeFile(f, data); return f; };
    const check = (f) => sourced('env_file_check JARVIS_GITHUB_REPO', [], { ACCEPTANCE_ENV_FILE: f });
    // uforståelige former: FATAL
    for (const [name, text] of [["yaml.env", "JARVIS_GITHUB_REPO: acme/prod\n"], ["bare.env", "JARVIS_GITHUB_REPO acme/prod\n"], ["export-yaml.env", "export JARVIS_GITHUB_REPO: acme/prod\n"]]) {
      expect(check(await write(name, text)).stdout, name).toMatch(/^FATAL: linjen for JARVIS_GITHUB_REPO/);
    }
    // interpolasjon: FATAL
    for (const [name, text] of [["interp1.env", "JARVIS_GITHUB_REPO=${PROD_REPO}\n"], ["interp2.env", "JARVIS_GITHUB_REPO=\"acme/$OWNER\"\n"]]) {
      expect(check(await write(name, text)).stdout, name).toMatch(/^FATAL: JARVIS_GITHUB_REPO i .* bruker variabel-interpolasjon/);
    }
    // rene former: ingenting å melde
    for (const [name, text] of [["ok1.env", "JARVIS_GITHUB_REPO=acme/prod\n"], ["ok2.env", "# JARVIS_GITHUB_REPO: kommentar\nSOME_URL=https://github.com/${JARVIS_GITHUB_REPO}\nJARVIS_GITHUB_REPO_X: y\n"], ["tom.env", ""]]) {
      expect(check(await write(name, text)).stdout, name).toBe("");
    }
    // helt: scriptet avbryter (exit 2) FØR noe røres, og sier hvorfor; en ren fil gjør det ikke
    const { config } = await setup();
    const yaml = await write("e2e-yaml.env", "JARVIS_GITHUB_REPO: acme/prod\n");
    const r = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/annet", ACCEPTANCE_ENV_FILE: yaml });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("er ikke på formen JARVIS_GITHUB_REPO=verdi");
    expect(r.stderr).toContain("avbryter");
    // Avbruddet skjer FØR de senere kontrollene: uten det ville scriptet fortsatt og også endt med exit 2 på allowed_repos-sjekken (mutant M6: FATAL uten return 2)
    expect(r.stderr, "scriptet skal stoppe før allowed_repos-sjekken").not.toContain("står ikke i runner.allowed_repos");
    const clean = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/annet", ACCEPTANCE_ENV_FILE: await write("e2e-clean.env", "JARVIS_GITHUB_REPO=acme/prod\n") });
    expect(clean.stderr).not.toContain("vernet kan ikke tolke");
    expect(clean.stderr).toContain("står ikke i runner.allowed_repos");
    // NUL-bytes og ikke-UTF-8 på samme fil: verdien leses fortsatt (grep -a, LC_ALL=C), og vernet nekter repoet
    const binary = await write("binary.env", Buffer.concat([Buffer.from("FOO=\xff\xfe\x00bar\n", "latin1"), Buffer.from("JARVIS_GITHUB_REPO=acme/prod\n"), Buffer.from("BAR=caf\xe9\n", "latin1")]));
    expect(sourced('env_file_value JARVIS_GITHUB_REPO', [], { ACCEPTANCE_ENV_FILE: binary }).stdout).toBe("acme/prod");
    expect(sourced('production_repo_reason "$1"', ["acme/prod"], { ACCEPTANCE_ENV_FILE: binary }).status).toBe(0);
    // FIFO: ikke en vanlig fil -> advarsel og ingen lesing (ville ellers henge)
    const fifo = join(dir, "fifo.env");
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      const t0 = Date.now();
      const w = check(fifo);
      expect(Date.now() - t0, "FIFO skal ikke henge vernet").toBeLessThan(5000);
      expect(w.stdout).toMatch(/^WARN: kan ikke lese .* IKKE sjekket/);
      const e2e = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/annet", ACCEPTANCE_ENV_FILE: fifo });
      expect(e2e.stderr).toContain("ADVARSEL: kan ikke lese");
      expect(e2e.stderr).toContain("står ikke i runner.allowed_repos");
    }
    // /dev/zero og kataloger: ikke vanlige filer
    for (const special of ["/dev/zero", dir]) expect(check(special).stdout, special).toMatch(/^WARN:/);
    // manglende fil: stille (ingen advarsel: det er normalt at `.env` ikke finnes)
    expect(check(join(dir, "finnes-ikke.env")).stdout).toBe("");
  });

  it.skipIf(!HAS_UTF8_LOCALE)("D-479 (reviewer B delta 2): ikke-UTF-8 bytes PÅ SAMME LINJE som JARVIS_GITHUB_REPO (latin-1-kommentar, latin-1 i verdien) i en UTF-8-locale gir fortsatt riktig verdi og nektelse, og FATAL oppdages også da; vernet faller ikke åpent", async () => {
    const dir = await makeTempDir("acc-env-latin1");
    const write = async (name, data) => { const f = join(dir, name); await writeFile(f, data); return f; };
    const L1 = (text) => Buffer.from(text, "latin1");   // \xe6 \xf8 \xe5 som ENKELT-bytes = ugyldig UTF-8 (en norsk kommentar lagret som latin-1/cp1252)
    const utf8 = { LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };
    const value = (f) => sourced("env_file_value JARVIS_GITHUB_REPO", [], { ACCEPTANCE_ENV_FILE: f, ...utf8 });
    const deny = (repo, f) => sourced('production_repo_reason "$1"', [repo], { ACCEPTANCE_ENV_FILE: f, ...utf8 });
    const check = (f) => sourced("env_file_check JARVIS_GITHUB_REPO", [], { ACCEPTANCE_ENV_FILE: f, ...utf8 });
    // verdien leses med ugyldig UTF-8 på samme linje (kommentar), før, etter og i annen eksport-/mellomromsform
    const sameLine = [
      ["comment.env", L1("JARVIS_GITHUB_REPO=acme/prod # kommentar \xe6\n")],
      ["export-quoted.env", L1("export JARVIS_GITHUB_REPO=\"acme/prod\" # prod-repoet v\xe5rt \xf8\n")],
      ["crlf-tab.env", L1("JARVIS_GITHUB_REPO = acme/prod\t# \xe6\xf8\xe5\r\n")],
      ["before.env", L1("X=caf\xe9\nJARVIS_GITHUB_REPO=acme/prod\n")],
      ["after.env", L1("JARVIS_GITHUB_REPO=acme/prod\nX=caf\xe9\n")],
    ];
    for (const [name, data] of sameLine) {
      const f = await write(name, data);
      expect(value(f).stdout, `${name}: verdien`).toBe("acme/prod");
      expect(deny("acme/prod", f).status, `${name}: nektelse`).toBe(0);
      expect(deny("acme/prod", f).stdout, name).toContain("JARVIS_GITHUB_REPO i .env");
      expect(check(f).stdout, `${name}: ingen falsk melding`).toBe("");
    }
    // ugyldig byte INNE I verdien: ikke en form vernet tolker (hvitliste) -> FATAL, og production_repo_reason nekter (fail-closed), ingen krasj
    const inValue = await write("in-value.env", L1("JARVIS_GITHUB_REPO=acme/pr\xe9d\n"));
    expect(value(inValue).status).toBe(0);
    expect(check(inValue).stdout).toMatch(/^FATAL: linjen for JARVIS_GITHUB_REPO/);
    expect(deny("acme/prod", inValue).status, "en .env vernet ikke kan tolke nekter alt").toBe(0);
    expect(deny("acme/prod", inValue).stdout).toContain("kan ikke tolkes");
    // FATAL oppdages også med latin-1 på linjen (YAML-kolon og interpolasjon)
    for (const [name, data, re] of [
      ["yaml.env", L1("JARVIS_GITHUB_REPO: acme/prod # \xe6\n"), /^FATAL: linjen for JARVIS_GITHUB_REPO/],
      ["interp.env", L1("JARVIS_GITHUB_REPO=${X} # \xe6\n"), /^FATAL: JARVIS_GITHUB_REPO i .* bruker variabel-interpolasjon/],
      ["interp-quoted.env", L1("JARVIS_GITHUB_REPO=\"acme/$OWNER\" # caf\xe9\n"), /^FATAL: JARVIS_GITHUB_REPO i .* bruker variabel-interpolasjon/],
    ]) {
      expect(check(await write(name, data)).stdout, name).toMatch(re);
    }
    // ende-til-ende: hele scriptet nekter acme/prod (aldri produksjon) når .env bare har ugyldig UTF-8 i kommentaren, og avbryter på YAML-kolon med latin-1
    const { config } = await setup();
    const e2e = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "acme/prod", ACCEPTANCE_ENV_FILE: await write("e2e-comment.env", L1("JARVIS_GITHUB_REPO=acme/prod # kommentar \xe6\n")), ...utf8 });
    expect(e2e.status).toBe(2);
    expect(e2e.stderr).toContain("PRODUKSJONSREPOET (JARVIS_GITHUB_REPO i .env)");
    const e2eYaml = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/annet", ACCEPTANCE_ENV_FILE: await write("e2e-yaml.env", L1("JARVIS_GITHUB_REPO: acme/prod # \xe6\n")), ...utf8 });
    expect(e2eYaml.status).toBe(2);
    expect(e2eYaml.stderr).toContain("er ikke på formen JARVIS_GITHUB_REPO=verdi");
    expect(e2eYaml.stderr, "stopper før allowed_repos-sjekken").not.toContain("står ikke i runner.allowed_repos");
    // en sti med norske tegn (gyldig UTF-8) i ACCEPTANCE_ENV_FILE virker også (meldingene bærer stien)
    const nordic = join(dir, "norsk-sti-\u00e6\u00f8\u00e5");
    await mkdir(nordic);
    const nordicFile = join(nordic, ".env");
    await writeFile(nordicFile, "JARVIS_GITHUB_REPO: acme/prod\n");
    expect(check(nordicFile).stdout).toMatch(/^FATAL: linjen for JARVIS_GITHUB_REPO i .*norsk-sti-\u00e6\u00f8\u00e5/);
    const e2eNordic = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/annet", ACCEPTANCE_ENV_FILE: nordicFile, ...utf8 });
    expect(e2eNordic.status).toBe(2);
    expect(e2eNordic.stderr).toContain("avbryter");
    expect(e2eNordic.stderr).not.toContain("står ikke i runner.allowed_repos");
  });

  it("D-479 (reviewer B delta 3): .env tolkes med en STRENG hvitliste - former compose leser annerledes (escapes, flerlinjede verdier, Unicode-blanke, backslash, mellomrom i verdien, YAML-kolon, interpolasjon) gir FATAL og nekter alt, enkle former leses som før", async () => {
    const dir = await makeTempDir("acc-env-strict");
    const write = async (name, data) => { const f = join(dir, name); await writeFile(f, data); return f; };
    const B = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "utf8"))));
    const value = (f, env = {}) => sourced("env_file_value JARVIS_GITHUB_REPO", [], { ACCEPTANCE_ENV_FILE: f, ...env }).stdout;
    const deny = (repo, f, env = {}) => sourced('production_repo_reason "$1"', [repo], { ACCEPTANCE_ENV_FILE: f, ...env });
    const check = (f, env = {}) => sourced("env_file_check JARVIS_GITHUB_REPO", [], { ACCEPTANCE_ENV_FILE: f, ...env }).stdout;
    const locales = [{ LC_ALL: "C" }, ...(HAS_UTF8_LOCALE ? [{ LC_ALL: "C.UTF-8" }] : [])];
    const P = "acme/prod";
    // (a) enkle former: tolkes, nektes som produksjon, ingen melding - i alle locale
    const simple = [
      ["plain", `JARVIS_GITHUB_REPO=${P}\n`],
      ["spaces-around-eq", `JARVIS_GITHUB_REPO = ${P}\n`],
      ["space-after-eq-quoted", `JARVIS_GITHUB_REPO= "${P}"\n`],
      ["export", `export JARVIS_GITHUB_REPO=${P}\n`],
      ["export-tab", `export\tJARVIS_GITHUB_REPO=${P}\n`],
      ["tab-before-eq", `JARVIS_GITHUB_REPO\t=${P}\n`],
      ["single-quoted", `JARVIS_GITHUB_REPO='${P}'\n`],
      ["double-quoted-comment", `JARVIS_GITHUB_REPO="${P}" # kommentar\n`],
      ["comment-with-dollar", `JARVIS_GITHUB_REPO=${P} # koster $5\n`],
      ["crlf", `JARVIS_GITHUB_REPO=${P}\r\nB=2\r\n`],
      ["bom-first", `\ufeffJARVIS_GITHUB_REPO=${P}\n`],
      ["bom-export", `\ufeffexport JARVIS_GITHUB_REPO=${P}\n`],
      ["form-feed-lead", `\fJARVIS_GITHUB_REPO=${P}\n`],
      ["no-final-newline", `JARVIS_GITHUB_REPO=${P}`],
      ["case-and-git-alias", `JARVIS_GITHUB_REPO=ACME/Prod.git/\n`],
    ];
    for (const [name, text] of simple) {
      const f = await write(`simple-${name}.env`, text);
      for (const env of locales) {
        expect(value(f, env), `${name} ${JSON.stringify(env)}: verdi`).toBe(name === "case-and-git-alias" ? "ACME/Prod.git/" : P);
        expect(check(f, env), `${name} ${JSON.stringify(env)}: ingen melding`).toBe("");
        expect(deny(P, f, env).status, `${name} ${JSON.stringify(env)}: nektelse`).toBe(0);
      }
    }
    // tom verdi: ingenting å nekte
    const empty = await write("empty.env", "JARVIS_GITHUB_REPO=\n");
    expect(value(empty)).toBe("");
    expect(check(empty)).toBe("");
    // (b) former reviewer B sin differensialfuzz mot docker compose viste at compose leser som acme/prod mens et løsere vern ikke gjorde: FATAL, og alt nektes (fail-closed)
    const risky = [
      ["multiline-double-quote", `JARVIS_GITHUB_REPO="\n${P}"\n`],
      ["multiline-single-quote", `JARVIS_GITHUB_REPO='\n${P}'\n`],
      ["escape-n", `JARVIS_GITHUB_REPO="${P}\\n"\n`],
      ["escape-t", `JARVIS_GITHUB_REPO="${P}\\t"\n`],
      ["escape-n-first", `JARVIS_GITHUB_REPO="\\n${P}"\n`],
      ["escape-r", `JARVIS_GITHUB_REPO="${P}\\r"\n`],
      ["backslash-unquoted", `JARVIS_GITHUB_REPO=${P}\\n\n`],
      ["quoted-with-spaces", `JARVIS_GITHUB_REPO=" ${P} "\n`],
      ["nbsp-leading", `\u00a0JARVIS_GITHUB_REPO=${P}\n`],
      ["ideographic-space-leading", `\u3000JARVIS_GITHUB_REPO=${P}\n`],
      ["em-space-leading", `\u2003JARVIS_GITHUB_REPO=${P}\n`],
      ["nel-leading", `\u0085JARVIS_GITHUB_REPO=${P}\n`],
      ["nbsp-after-eq", `JARVIS_GITHUB_REPO=\u00a0${P}\n`],
      ["nbsp-before-eq", `JARVIS_GITHUB_REPO\u00a0=${P}\n`],
      ["nbsp-trailing", `JARVIS_GITHUB_REPO=${P}\u00a0\n`],
      ["nbsp-after-export", `export\u00a0JARVIS_GITHUB_REPO=${P}\n`],
      ["yaml-colon", `JARVIS_GITHUB_REPO: ${P}\n`],
      ["yaml-colon-nospace", `JARVIS_GITHUB_REPO:${P}\n`],
      ["interpolation", `OWNER=acme\nJARVIS_GITHUB_REPO=\${OWNER}/prod\n`],
      ["interpolation-default", `JARVIS_GITHUB_REPO=\${UNSETVAR:-${P}}\n`],
      ["interpolation-bare", `X=${P}\nJARVIS_GITHUB_REPO=$X\n`],
      ["hash-without-space", `JARVIS_GITHUB_REPO=${P}#c\n`],
      ["url-form", `JARVIS_GITHUB_REPO=https://github.com/${P}\n`],
      ["bare-name", `JARVIS_GITHUB_REPO\n`],
      ["key-with-dot-suffix", `JARVIS_GITHUB_REPO.x=${P}\n`],
      ["latin1-in-value", B(`JARVIS_GITHUB_REPO=acme/pr`, Buffer.from([0xe9]), "d\n")],
      // compose er en tokenizer: etter en verdi i anførselstegn kan en NY tilordning stå på samme linje (funnet av tilfeldig differensialfuzz mot docker compose)
      ["glued-after-double-quote", `A="x" JARVIS_GITHUB_REPO=${P}\n`],
      ["glued-after-quote-no-space", `A="x"JARVIS_GITHUB_REPO=${P}\n`],
      ["glued-after-single-quote", `A='x' JARVIS_GITHUB_REPO=${P}\n`],
      ["glued-after-tab-and-cr", `A="x"\t\rJARVIS_GITHUB_REPO=${P}\n`],
      ["glued-after-multiline-value", `A="x\ny" JARVIS_GITHUB_REPO=${P}\n`],
      ["glued-export-midline", `A="x" export JARVIS_GITHUB_REPO=${P}\n`],
      ["glued-after-nbsp", `A="x"\u00a0JARVIS_GITHUB_REPO=${P}\n`],
      ["glued-after-garbage-export", `export\texportJARVIS_GITHUB_REPO\t=" ${P}"JARVIS_GITHUB_REPO=${P}\n`],
      // omtaler som ikke er en egen tilordning feiler lukket (falsk positiv er bevisst: vernet gjetter ikke)
      ["mention-in-trailing-comment", `A=1 # sett JARVIS_GITHUB_REPO=${P} senere\n`],
      ["mention-in-other-value", "NOTE=bruk JARVIS_GITHUB_REPO her\n"],
      // reviewer B N2: en annen nøkkels flerlinjede verdi i anførselstegn SKJULER en linje for compose (siste linje vinner hos oss, men er en del av verdien hos compose) eller AVSLØRER en
      ["multiline-value-hides-assignment", `JARVIS_GITHUB_REPO=${P}\nX="abc\nJARVIS_GITHUB_REPO=owner/sandbox\ndef"\n`],
      ["multiline-value-reveals-assignment", `X="abc\n# lukker her" JARVIS_GITHUB_REPO=${P}\n`],
      ["open-quote-on-second-assignment", `A="x" B="abc\nJARVIS_GITHUB_REPO=${P}"\n`],
      // den andre tilordningen på linjen har det åpne anførselstegnet og skjuler en senere linje (mutant U5: tokenizeren stopper etter den første avsluttede verdien)
      ["open-quote-on-second-assignment-hides", `JARVIS_GITHUB_REPO=${P}\nA="x" B="abc\nJARVIS_GITHUB_REPO=owner/sandbox\ndef"\n`],
      ["open-single-quote", `A='abc\nJARVIS_GITHUB_REPO=owner/sandbox\n'\n`],
      ["escaped-quote-then-eol", `A="a\\"\nJARVIS_GITHUB_REPO=owner/sandbox\n"\n`],
      ["bom-then-open-quote", `\ufeffA="abc\nJARVIS_GITHUB_REPO=owner/sandbox\n"\n`],
      ["nbsp-then-open-quote", `\u00a0A="abc\nJARVIS_GITHUB_REPO=owner/sandbox\n"\n`],
      ["export-then-open-quote", `export A="abc\nJARVIS_GITHUB_REPO=owner/sandbox\n"\n`],
      ["yaml-colon-open-quote", `A: "abc\nJARVIS_GITHUB_REPO=owner/sandbox\n"\n`],
      // en gyldig kandidat etterfulgt av en ugyldig må fortsatt gi FATAL (ikke stopp ved den første gyldige), og en uavsluttet `${NAVN`-referanse er ikke en gyldig verdi
      ["valid-then-invalid", `JARVIS_GITHUB_REPO=${P}\nJARVIS_GITHUB_REPO: x\n`],
      ["unclosed-brace-reference", `JARVIS_GITHUB_REPO=${P} \${JARVIS_GITHUB_REPO\n`],
    ];
    for (const [name, data] of risky) {
      const f = await write(`risky-${name}.env`, data);
      for (const env of locales) {
        expect(check(f, env), `${name} ${JSON.stringify(env)}: FATAL`).toMatch(/^FATAL: /);
        expect(deny("owner/annet", f, env).status, `${name} ${JSON.stringify(env)}: nekter alt, også et repo som ikke ligner`).toBe(0);
      }
    }
    // siste tilordning vinner, også når den er tom (compose: en senere tom verdi overstyrer en tidligere; mutant Q15)
    const emptyLast = await write("empty-last.env", `JARVIS_GITHUB_REPO=${P}\nJARVIS_GITHUB_REPO=\n`);
    expect(value(emptyLast)).toBe("");
    expect(deny(P, emptyLast).status).toBe(1);
    // N3: meldingen oppgir linjenummer, men ALDRI innholdet (linjen kan inneholde en hemmelighet)
    const secretLine = await write("secret-line.env", `OK=1\nA="hemmelig-verdi-123" JARVIS_GITHUB_REPO=${P}\n`);
    expect(check(secretLine)).toMatch(/^FATAL: linjen for JARVIS_GITHUB_REPO i .* \(linje 2\) er ikke på formen/);
    expect(check(secretLine)).not.toContain("hemmelig-verdi-123");
    const openQuote = await write("open-quote-secret.env", `A=1\nB="hemmelig-verdi-456\nC=2"\n`);
    expect(check(openQuote)).toMatch(/\(linje 2\)/);
    expect(check(openQuote)).not.toContain("hemmelig-verdi-456");
    // awk mangler: vernet gjetter ikke, men feiler lukket
    const noAwk = join(dir, "bin-uten-awk");
    await mkdir(noAwk);
    for (const tool of ["bash", "grep", "date", "dirname", "cat"]) {
      const real = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8", env: { PATH: process.env["PATH"] } }).stdout.trim();
      if (real) await symlink(real, join(noAwk, tool));
    }
    const noAwkRun = spawnSync(join(noAwk, "bash"), ["-c", `source "${SCRIPT}"; env_file_check JARVIS_GITHUB_REPO; production_repo_reason owner/annet >/dev/null; echo " rc=$?"`], { env: { PATH: noAwk, HOME: tmpdir(), LC_ALL: "C", ACCEPTANCE_SOURCE_ONLY: "1", ACCEPTANCE_ENV_FILE: await write("plain-for-noawk.env", `JARVIS_GITHUB_REPO=${P}\n`) }, encoding: "utf8", timeout: 60_000 });
    expect(noAwkRun.stdout).toMatch(/^FATAL: kunne ikke analysere .* \(awk mangler eller feilet\)/);
    expect(noAwkRun.stdout, "production_repo_reason nekter også da").toContain("rc=0");
    // (c) ikke-kandidater: andre nøkler, kommentarer og bruk av variabelen i en annen verdi gir ingen melding
    const notCandidates = await write("not-candidates.env", "# JARVIS_GITHUB_REPO: kommentar\n   # JARVIS_GITHUB_REPO=x\nNOT_JARVIS_GITHUB_REPO=x\nJARVIS_GITHUB_REPO_OLD: y\nXJARVIS_GITHUB_REPO=z\nexportJARVIS_GITHUB_REPO=q\nSOME_URL=https://github.com/${JARVIS_GITHUB_REPO}\nFALLBACK=${JARVIS_GITHUB_REPO:-acme/x}\nBARE=$JARVIS_GITHUB_REPO\nQUOTED=\"a/${JARVIS_GITHUB_REPO}/b\"\nTWO=${JARVIS_GITHUB_REPO}/${JARVIS_GITHUB_REPO}\n");
    expect(check(notCandidates)).toBe("");
    expect(value(notCandidates)).toBe("");
    expect(deny("acme/prod", notCandidates).status).toBe(1);
  });

  it.skipIf(!HAS_DOCKER_COMPOSE)("D-479 (reviewer B delta 3): differensialtest mot ekte `docker compose config` - ALT compose leser som produksjonsrepoet er enten FATAL eller nektet av vernet (ingen fail-open), i C og UTF-8", async () => {
    const dir = await makeTempDir("acc-env-oracle");
    await writeFile(join(dir, "compose.yml"), 'services:\n  x:\n    image: busybox\n    environment:\n      JARVIS_GITHUB_REPO: "${JARVIS_GITHUB_REPO-__UNSET__}"\n');
    const P = "acme/prod";
    const B = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "utf8"))));
    const composeValue = (file) => {
      const r = spawnSync("docker", ["compose", "--env-file", file, "-f", join(dir, "compose.yml"), "config", "--format", "json"], { env: { PATH: process.env["PATH"], HOME: dir }, encoding: "utf8", timeout: 60_000, cwd: dir });
      if (r.status !== 0) return undefined;   // compose avviser filen selv: ingen utrulling å beskytte
      try { return JSON.parse(r.stdout).services.x.environment.JARVIS_GITHUB_REPO; } catch { return undefined; }
    };
    const isProd = (v) => typeof v === "string" && v.trim().toLowerCase().replace(/(\/|\.git)+$/g, "") === P;
    const cases = [
      ["enkel", `JARVIS_GITHUB_REPO=${P}\n`], ["mellomrom rundt =", `JARVIS_GITHUB_REPO = ${P}\n`], ["mellomrom etter = + anførselstegn", `JARVIS_GITHUB_REPO= "${P}"\n`],
      ["yaml-kolon", `JARVIS_GITHUB_REPO: ${P}\n`], ["yaml-kolon uten mellomrom", `JARVIS_GITHUB_REPO:${P}\n`], ["export", `export JARVIS_GITHUB_REPO=${P}\n`], ["export med tab", `export\tJARVIS_GITHUB_REPO=${P}\n`],
      ["BOM først", `\ufeffJARVIS_GITHUB_REPO=${P}\n`], ["BOM + export", `\ufeffexport JARVIS_GITHUB_REPO=${P}\n`], ["CRLF", `JARVIS_GITHUB_REPO=${P}\r\nB=2\r\n`], ["anførselstegn + kommentar", `JARVIS_GITHUB_REPO="${P}" # kommentar\n`],
      ["kommentar med tab", `JARVIS_GITHUB_REPO=${P}\t# c\n`], ["escaped anførselstegn", `JARVIS_GITHUB_REPO="${P}\\"x"\n`], ["prod sist", `JARVIS_GITHUB_REPO=other/x\nJARVIS_GITHUB_REPO=${P}\n`], ["prod først, annen sist", `JARVIS_GITHUB_REPO=${P}\nJARVIS_GITHUB_REPO=other/x\n`],
      ["interpolasjon", `OWNER=acme\nJARVIS_GITHUB_REPO=\${OWNER}/prod\n`], ["interpolasjon med standardverdi", `JARVIS_GITHUB_REPO=\${UNSETVAR:-${P}}\n`], ["anførselstegn + interpolasjon", `X=${P}\nJARVIS_GITHUB_REPO="\${X}"\n`], ["interpolasjon $X", `X=${P}\nJARVIS_GITHUB_REPO=$X\n`],
      ["latin-1 på samme linje", B(`JARVIS_GITHUB_REPO=${P} # kommentar `, Buffer.from([0xe6]), "\n")], ["latin-1 på en annen linje", B("# kommentar ", Buffer.from([0xe6]), `\nJARVIS_GITHUB_REPO=${P}\n`)], ["NUL på en annen linje", B("X=a", Buffer.from([0]), `\nJARVIS_GITHUB_REPO=${P}\n`)],
      ["uten sluttlinje", `JARVIS_GITHUB_REPO=${P}`], ["flerlinjet dobbelt anførselstegn", `JARVIS_GITHUB_REPO="\n${P}"\n`], ["flerlinjet enkelt anførselstegn", `JARVIS_GITHUB_REPO='\n${P}'\n`], ["flerlinjet med repo først", `JARVIS_GITHUB_REPO="${P}\n"\n`],
      ["escape n", `JARVIS_GITHUB_REPO="${P}\\n"\n`], ["escape t", `JARVIS_GITHUB_REPO="${P}\\t"\n`], ["escape n først", `JARVIS_GITHUB_REPO="\\n${P}"\n`], ["escape r", `JARVIS_GITHUB_REPO="${P}\\r"\n`],
      ["backslash uanført", `JARVIS_GITHUB_REPO=${P}\\n\n`], ["ledende NBSP", `\u00a0JARVIS_GITHUB_REPO=${P}\n`], ["ledende U+3000", `\u3000JARVIS_GITHUB_REPO=${P}\n`], ["ledende U+2003", `\u2003JARVIS_GITHUB_REPO=${P}\n`], ["ledende form feed", `\fJARVIS_GITHUB_REPO=${P}\n`], ["ledende vertikal tab", `\vJARVIS_GITHUB_REPO=${P}\n`],
      ["NBSP etter =", `JARVIS_GITHUB_REPO=\u00a0${P}\n`], ["NBSP før =", `JARVIS_GITHUB_REPO\u00a0=${P}\n`], ["NBSP på slutten", `JARVIS_GITHUB_REPO=${P}\u00a0\n`], ["form feed før =", `JARVIS_GITHUB_REPO\f=${P}\n`], ["tab før =", `JARVIS_GITHUB_REPO\t=${P}\n`],
      ["dollar i kommentar", `JARVIS_GITHUB_REPO=${P} # koster $5\n`], ["dollar i enkle anførselstegn", `JARVIS_GITHUB_REPO='acme/pr$od'\n`], ["verdi med mellomrom i anførselstegn", `JARVIS_GITHUB_REPO=" ${P} "\n`], ["store bokstaver, .git og slash", `JARVIS_GITHUB_REPO=ACME/Prod.git/\n`],
      ["URL-form", `JARVIS_GITHUB_REPO=https://github.com/${P}\n`], ["export uten mellomrom", `exportJARVIS_GITHUB_REPO=${P}\n`], ["annen nøkkel med samme prefiks", `JARVIS_GITHUB_REPO_OLD=${P}\n`], ["sitert nøkkel", `"JARVIS_GITHUB_REPO"=${P}\n`],
      ["tilordning etter anførselstegn på samme linje", `A="x" JARVIS_GITHUB_REPO=${P}\n`], ["tilordning rett etter anførselstegn", `A="x"JARVIS_GITHUB_REPO=${P}\n`], ["tilordning etter enkle anførselstegn", `A='x' JARVIS_GITHUB_REPO=${P}\n`],
      ["tilordning etter flerlinjet verdi", `A="x\ny" JARVIS_GITHUB_REPO=${P}\n`], ["tilordning etter tab og CR", `A="x"\t\rJARVIS_GITHUB_REPO=${P}\n`], ["export midt på linjen", `A="x" export JARVIS_GITHUB_REPO=${P}\n`],
      ["søppel-export fulgt av tilordning", `export\texportJARVIS_GITHUB_REPO\t=" ${P}"JARVIS_GITHUB_REPO=${P}\n`],
      ["flerlinjet verdi skjuler en linje (B N2)", `JARVIS_GITHUB_REPO=${P}\nX="abc\nJARVIS_GITHUB_REPO=owner/sandbox\ndef"\n`], ["flerlinjet verdi avslører en linje (B N2)", `X="abc\n# lukker her" JARVIS_GITHUB_REPO=${P}\n`],
      ["åpent anførselstegn på andre tilordning", `A="x" B="abc\nJARVIS_GITHUB_REPO=${P}"\n`], ["åpent enkelt anførselstegn", `A='abc\nJARVIS_GITHUB_REPO=${P}\n'\n`], ["export + åpent anførselstegn", `export A="abc\nJARVIS_GITHUB_REPO=${P}\n"\n`], ["åpent anførselstegn på andre tilordning skjuler en senere linje", `JARVIS_GITHUB_REPO=${P}\nA="x" B="abc\nJARVIS_GITHUB_REPO=owner/sandbox\ndef"\n`],
      ["tom verdi", "JARVIS_GITHUB_REPO=\n"], ["repo-linje etter 2000 linjer", `${Array.from({ length: 2000 }, (_, i) => `K${i}=v${i}`).join("\n")}\nJARVIS_GITHUB_REPO=${P}\n`],
    ];
    let prodCases = 0;
    for (const [name, data] of cases) {
      const f = join(dir, "case.env");
      await writeFile(f, data);
      const v = composeValue(f);
      if (!isProd(v)) continue;
      prodCases += 1;
      for (const env of [{ LC_ALL: "C" }, ...(HAS_UTF8_LOCALE ? [{ LC_ALL: "C.UTF-8" }] : [])]) {
        const check = sourced("env_file_check JARVIS_GITHUB_REPO", [], { ACCEPTANCE_ENV_FILE: f, ...env }).stdout;
        const verdict = sourced('production_repo_reason "$1"', [P], { ACCEPTANCE_ENV_FILE: f, ...env }).status;
        expect(check.startsWith("FATAL") || verdict === 0, `FAIL-OPEN: compose leser ${JSON.stringify(v)} for «${name}» (${JSON.stringify(env)}), men vernet verken avbryter eller nekter`).toBe(true);
      }
    }
    expect(prodCases, "orakelet må faktisk ha sett mange produksjonsverdier").toBeGreaterThan(25);
  }, 240_000);

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("D-479: en ulesbar .env (ingen lesetilgang) gir en advarsel, ikke en stille bortfall (kun som ikke-root)", async () => {
    const dir = await makeTempDir("acc-env3");
    const f = join(dir, "ulesbar.env");
    await writeFile(f, "JARVIS_GITHUB_REPO=acme/prod\n");
    await chmod(f, 0o000);
    expect(sourced("env_file_check JARVIS_GITHUB_REPO", [], { ACCEPTANCE_ENV_FILE: f }).stdout).toMatch(/^WARN: kan ikke lese/);
  });

  it("D-479: ACCEPTANCE_REPO normaliseres til trimmet små bokstaver for allowed_repos-sammenligningen (eierens kontonavn har store bokstaver); det finnes ingen overstyring av produksjonsvernet", async () => {
    const r = sourced('for v in "$@"; do printf "[%s]\\n" "$(normalize_repo_arg "$v")"; done', ["FFrollerskis/Sandbox", "  Owner/Repo\t", "owner/repo"]);
    expect(r.stdout.trim().split("\n")).toEqual(["[ffrollerskis/sandbox]", "[owner/repo]", "[owner/repo]"]);
    const { config } = await setup();
    // Plausible «overstyringer» eksisterer ikke: produksjonsrepoet nektes uansett variabler (en test som feller hvis noen legger til en bakdør).
    const overrides = { ACCEPT_ALLOW_PROD: "yes", ACCEPTANCE_ALLOW_PRODUCTION: "1", ACCEPT_FORCE: "1", FORCE: "1", ACCEPT_CONFIRM_RESTART: "yes", ACCEPT_SKIP_GUARD: "1", ACCEPTANCE_ALLOW_REPO: CANONICAL_GITHUB_REPO };
    for (const repo of [CANONICAL_GITHUB_REPO, ...LEGACY_GITHUB_REPOS, ...FORMER_CANONICAL_GITHUB_REPOS]) {
      const denied = run(["--with-restart"], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: repo, ...overrides });
      expect(denied.status, repo).toBe(2);
      expect(denied.stderr, repo).toContain("PRODUKSJONSREPOET");
    }
  });

  it("B-L5: --with-restart krever bekreftelse (ACCEPT_CONFIRM_RESTART=yes, eller RESTART på terminal) - uten den er svaret exit 2 med advarsel, og ingenting røres", async () => {
    const { h, config } = await setup();
    const refused = run(["--with-restart"], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/repo" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("ADVARSEL: --with-restart sender SIGKILL til den LEVENDE jarvis-job-runner");
    expect(refused.stderr).toContain("--with-restart krever bekreftelse");
    // feil svar er ikke bekreftelse (stdin er ikke en terminal i testen, så eneste vei er miljøvariabelen - kun nøyaktig «yes»)
    for (const value of ["1", "true", "YES", "ja", ""]) {
      expect(run(["--with-restart"], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/repo", ACCEPT_CONFIRM_RESTART: value }).status, value).toBe(2);
    }
    // med bekreftelse går scriptet videre til NESTE grind (her: repoet står ikke på allowlisten) - beviser at det var bekreftelsen som stoppet
    const passed = run(["--with-restart"], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/annet", ACCEPT_CONFIRM_RESTART: "yes" });
    expect(passed.status).toBe(2);
    expect(passed.stderr).toContain("står ikke i runner.allowed_repos");
    expect(passed.stderr).not.toContain("krever bekreftelse");
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("manglende config / token / socket -> exit 2 med tydelig melding", async () => {
    const { h, config } = await setup();
    expect(run([], { JARVIS_JOB_RUNNER_CONFIG: join(h.root, "finnes-ikke.json"), ACCEPTANCE_REPO: "owner/repo" }).status).toBe(2);
    const broken = join(h.root, "uten-socket.json");
    await writeFile(broken, JSON.stringify({ version: 1, runner: { socket_path: join(h.root, "ingen.sock"), token_file: h.tokenFile, base_dir: h.baseDir, network: "jarvis-jobs", image: "x", allowed_repos: ["owner/repo"], git_credentials: {} }, egress_proxy: {} }));
    const noSocket = run([], { JARVIS_JOB_RUNNER_CONFIG: broken, ACCEPTANCE_REPO: "owner/repo" });
    expect(noSocket.status).toBe(2);
    expect(noSocket.stderr).toContain("finner ikke socketen");
    void config;
  });
});

/** Starter tjenesten som egen prosess og returnerer stier + en stoppfunksjon. `options` går uendret til createHarness (f.eks. requestTokenSlugs). */
function startServe(options) {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./support/serve.mjs", import.meta.url)), ...(options ? [JSON.stringify(options)] : [])], { stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const info = JSON.parse(buf.slice(0, nl));
        resolveStart({ ...info, stop: () => { child.stdin.end(); } });
      }
    });
    child.on("error", rejectStart);
    setTimeout(() => rejectStart(new Error("serve.mjs startet ikke")), 20_000).unref();
  });
}
let served = [];
afterEach(() => { for (const s of served) s.stop(); served = []; });
async function setupServed(options) {
  const info = await startServe(options);
  served.push(info);
  const config = join(info.root, "job-runner.json");
  await writeFile(config, JSON.stringify({
    version: 1,
    runner: {
      socket_path: info.socketPath, token_file: info.tokenFile, base_dir: info.baseDir, network: "jarvis-jobs", image: `sha256:${"a".repeat(64)}`,
      allowed_repos: ["owner/repo"],
      git_credentials: { "owner/repo": info.requestTokenRepos.includes("owner/repo") ? { source: "request" } : { token_file: info.gitTokenFiles["owner/repo"] } }
    },
    egress_proxy: { listen_host: "172.30.77.1", listen_port: 3128 }
  }));
  return { info, config, health: () => apiRequest(info.socketPath, { token: RUNNER_TOKEN, path: "/v1/health" }) };
}

describe("C: hjelpefunksjonene mot den EKTE vertstjenesten over Unix-socket", () => {
  /** Kjører bash som laster scriptet (ACCEPTANCE_SOURCE_ONLY=1) og så et lite testprogram med funksjonene. */
  async function sourceAndRun(h, config, body, extraEnv = {}) {
    const program = `
      set -uo pipefail
      source "${SCRIPT}"
      REPO=owner/repo; STAMP=test; WORK="$(mktemp -d)"; chmod 700 "$WORK"
      CONFIG="${config}"; load_policy
      ( umask 077; printf 'Authorization: Bearer %s\\n' "$(tr -d '\\n' < "$TOKEN_FILE")" > "$WORK/auth.hdr" )
      ${body}
      rm -rf "$WORK"
    `;
    return spawnSync("bash", ["-c", program], { env: { ...baseEnv, ACCEPTANCE_SOURCE_ONLY: "1", ...extraEnv }, encoding: "utf8", timeout: 60_000 });
  }

  it("load_policy leser feltene i riktig rekkefølge (ingen eval)", async () => {
    const { info: h, config } = await setupServed();
    const r = await sourceAndRun(h, config, 'echo "SOCKET=$SOCKET NETWORK=$NETWORK USER=$USER_SPEC MEM=$MEMORY PIDS=$PIDS GW=$GATEWAY PORT=$PROXY_PORT PREFIX=$PREFIX ALLOWED=$ALLOWED"');
    expect(r.stdout.trim()).toBe(`SOCKET=${h.socketPath} NETWORK=jarvis-jobs USER=10001:10001 MEM=1g PIDS=256 GW=172.30.77.1 PORT=3128 PREFIX=jarvis/ ALLOWED=owner/repo`);
  });

  it("B-M3: load_policy leser egress_proxy.allow fra den FAKTISKE konfigen (standard KUN api.anthropic.com:443 når den mangler), som J07 sjekker mot", async () => {
    const { info: h, config } = await setupServed();
    const standard = await sourceAndRun(h, config, 'echo "ALLOW=$PROXY_ALLOW"');
    expect(standard.stdout.trim()).toBe("ALLOW=api.anthropic.com:443");
    const explicit = JSON.parse(await readFile(config, "utf8"));
    explicit.egress_proxy.allow = ["api.anthropic.com:443", "github.com:443"];
    const withGithub = join(h.root, "med-github.json");
    await writeFile(withGithub, JSON.stringify(explicit));
    const opened = await sourceAndRun(h, withGithub, 'echo "ALLOW=$PROXY_ALLOW"');
    expect(opened.stdout.trim()).toBe("ALLOW=api.anthropic.com:443,github.com:443");
  });

  it("B-L5: J06 (minne- og gaffelbombe) kjøres KUN når J04 har bevist grensene - uten J04 PASS er svaret SKIP og ingen jobb opprettes", async () => {
    const text = await readFile(SCRIPT, "utf8");
    const body = text.slice(text.indexOf("check_J06() {"), text.indexOf("check_J07() {"));
    // grinden står FØR første jobb opprettes (bomben kjøres i en jobb): sjekkes statisk først, så koden under aldri kjører en bombe hvis grinden er fjernet
    expect(body.indexOf('J04_OK:-0')).toBeGreaterThan(-1);
    expect(body.indexOf('J04_OK:-0')).toBeLessThan(body.indexOf("create_job"));
    expect(text).toContain("J04_OK=1; record J04_docker_inspect PASS");
    const { info: h, config, health } = await setupServed();
    const r = await sourceAndRun(h, config, "ROWS=(); J04_OK=0; check_J06 | sed 's/^/J06: /'");
    expect(r.stdout).toMatch(/J06: J06_ressursgrenser\s+SKIP\s+krever J04 PASS/);
    expect((await health()).json.active_jobs).toBe(0);
  });

  it("B-M3/B-L4/B-L5 (statisk): J07 sjekker allowlisten fra konfigen og forventer 403 for github med standardkonfig; J04/J05 sjekker seccomp, apparmor og NoNewPrivs; J09 nekter å drepe en runner med andre aktive jobber", async () => {
    const text = await readFile(SCRIPT, "utf8");
    const part = (from, to) => text.slice(text.indexOf(from), text.indexOf(to));
    const j07 = part("check_J07() {", "check_J08() {");
    expect(j07).toContain("IFS=',' read -ra allow_entries <<<\"$PROXY_ALLOW\"");
    expect(j07).toContain("forventet 403 (står ikke i egress_proxy.allow)");
    expect(j07).toContain("ADVARSEL: en angriper-PAT kan pushe repoet ut");
    expect(j07).not.toMatch(/github\.com:443"[^\n]*forventet 200/); // den gamle, hardkodede «github OK»
    const j04 = part("check_J04() {", "check_J05() {");
    expect(j04).toContain("docker info --format '{{.SecurityOptions}}'");
    expect(j04).toContain("*name=seccomp*");
    expect(j04).toContain("seccomp/apparmor unconfined");
    const j05 = part("check_J05() {", "check_J06() {");
    expect(j05).toMatch(/Seccomp:\[\[:space:\]\]\*2/);
    expect(j05).toMatch(/NoNewPrivs:\[\[:space:\]\]\*1/);
    const j09 = part("check_J09() {", "check_J10() {");
    expect(j09.indexOf("active_jobs")).toBeGreaterThan(-1);
    expect(j09.indexOf("active_jobs")).toBeLessThan(j09.indexOf("systemctl kill"));
    // betingelsen selv (ikke bare at feltet leses): aktive jobber > 0, uleselig helse eller ikke-tall gir SKIP uten å røre runneren
    expect(j09).toContain('if [ "$HTTP_CODE" != "200" ] || ! [[ "$active" =~ ^[0-9]+$ ]] || [ "$active" -gt 0 ]; then record J09_reclaim_etter_krasj SKIP');
    expect(j09.indexOf("record J09_reclaim_etter_krasj SKIP \"runneren har")).toBeLessThan(j09.indexOf("create_job"));
  });

  it("api/create_job/cexec/delete_job fungerer mot ekte tjeneste; bearer-tokenet står aldri i prosessens argv", async () => {
    const { info: h, config, health } = await setupServed();
    const r = await sourceAndRun(h, config, `
      api GET /v1/health; echo "HEALTH=$HTTP_CODE $(resp_get status)"
      create_job; echo "CREATE=$? ID=\${JOB_ID:0:8} C=\${CONTAINER:0:11}"
      cexec 20000 sh -c 'echo hei; exit 3'; echo "EXEC=$EXEC_CODE OUT=\${EXEC_OUT//$'\\n'/}"
      delete_job "$JOB_ID"; echo "DELETE=$HTTP_CODE $(resp_get state)"
      delete_job "$JOB_ID"; echo "DELETE2=$HTTP_CODE $(resp_get state)"
    `);
    expect(r.stderr).toBe("");
    const out = Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
    expect(out["HEALTH"]).toBe("200 ok");
    expect(out["CREATE"]).toMatch(/^0 ID=[0-9a-f]{8} C=jarvis-job-$/);
    expect(out["EXEC"]).toBe("3 OUT=hei");
    expect(out["DELETE"]).toBe("200 gone");
    expect(out["DELETE2"]).toBe("200 gone");
    expect((await health()).json.active_jobs).toBe(0);
  });

  it("create_job mot repo som ikke er på allowlisten gir 403 (scriptet ville avbrutt i main før dette)", async () => {
    const { info: h, config } = await setupServed();
    const r = await sourceAndRun(h, config, 'REPO=owner/annet; create_job; echo "RC=$? HTTP=$HTTP_CODE ERR=$(resp_get error)"');
    expect(r.stdout.trim()).toBe("RC=1 HTTP=403 ERR=repo_not_allowed");
  });

  it("J11-stegene (publish, avvisninger) gir de svarene scriptet forventer — kjørt for ekte mot tjenesten", async () => {
    const { info: h, config } = await setupServed();
    const r = await sourceAndRun(h, config, `
      create_job
      cexec 60000 sh -c "echo x > A.txt && git checkout -q -b jarvis/accept-test && git add -A && git commit -q -m t && git rev-parse HEAD"
      SHA="\${EXEC_OUT//$'\\n'/}"
      api POST "/v1/jobs/$JOB_ID/publish" '{"branch":"jarvis/accept-test"}'; echo "PUBLISH=$HTTP_CODE SAME=$([ "$(resp_get commit_sha)" = "$SHA" ] && echo ja || echo nei)"
      for b in main master production refs/heads/main "jarvis/../main"; do api POST "/v1/jobs/$JOB_ID/publish" "$(node -e 'process.stdout.write(JSON.stringify({branch:process.argv[1]}))' "$b")"; echo "BAD[$b]=$HTTP_CODE"; done
      delete_job "$JOB_ID"
      create_job
      cexec 60000 sh -c "mkdir -p .github/workflows && echo 'name: x' > .github/workflows/x.yml && git checkout -q -b jarvis/accept-denied && git add -A && git commit -q -m x"
      api POST "/v1/jobs/$JOB_ID/publish" '{"branch":"jarvis/accept-denied"}'; echo "DENIED=$HTTP_CODE $(resp_get error)"
      delete_job "$JOB_ID"
      create_job
      api POST "/v1/jobs/$JOB_ID/publish" '{"branch":"jarvis/accept-empty"}'; echo "EMPTY=$HTTP_CODE $(resp_get error)"
      delete_job "$JOB_ID"
    `);
    expect(r.stderr).toBe("");
    const lines = r.stdout.trim().split("\n");
    expect(lines).toContain("PUBLISH=200 SAME=ja");
    for (const b of ["main", "master", "production", "refs/heads/main", "jarvis/../main"]) expect(lines).toContain(`BAD[${b}]=400`);
    expect(lines).toContain("DENIED=422 path_denied");
    expect(lines).toContain("EMPTY=422 no_changes");
    expect(gitSync(h.origins["owner/repo"], ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/jarvis/accept-test\nrefs/heads/main");
  });

  it("helse-sjekken J02 mot den ekte tjenesten: PASS, og den bekrefter at policyen ikke kan overstyres (ukjent felt og env-navn utenfor allow-listen avvises uten bivirkning)", async () => {
    const { info: h, config, health } = await setupServed();
    const r = await sourceAndRun(h, config, "ROWS=(); check_J02 | sed 's/^/J02: /'");
    expect(r.stdout).toMatch(/J02: J02_helse\s+PASS/);
    expect(r.stdout).toContain("ukjent felt (image) og env-navn utenfor allow-listen (PATH) avvises 400");
    expect((await health()).json.active_jobs).toBe(0);
  });

  it("filrettighets-sjekken J01 oppdager åpne moduser (PAT/token/config/socket) og godtar riktige", async () => {
    const { info: h, config } = await setupServed();
    await chmod(h.tokenFile, 0o644);
    await mkdir(join(h.root, "x"), { recursive: true });
    const r = await sourceAndRun(h, config, `ROWS=(); check_J01 | sed 's/^/J01: /'`);
    expect(r.stdout).toMatch(/J01: J01_filrettigheter\s+FAIL/);
    expect(r.stdout).toContain("tokenfil tilgjengelig for andre");
    expect(r.stdout).toContain("config ikke eid av root"); // testkonfig er ikke root-eid
    expect(r.stdout).toContain("socket-katalogen har modus"); // testkatalogen er 0700, ikke 0750
  });
});

describe("D: repo med `source: request` (kortlevd token fra worker): scriptet sender tokenet fra en fil - aldri i argv - og nekter tvetydige kall", () => {
  const REQUEST_TOKEN = syntheticInstallationToken(300, 5);
  const ANTHROPIC_DUMMY = "sk-ant-api03-AKSEPTANSE-DUMMY-IKKE-EN-EKTE-NOKKEL-0123456789";

  async function tokenFile(info, mode = 0o600, content = `${REQUEST_TOKEN}\n`) {
    const file = join(info.root, "accept-git-token");
    await writeFile(file, content);
    await chmod(file, mode);
    return file;
  }
  const abortRun = (config, env) => run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "owner/repo", ...env });

  it("load_policy leser hvilke repoer som er `request`, og PAT-fil-listen inneholder ingen tomme/udefinerte oppføringer", async () => {
    const { info: h, config } = await setupServed({ requestTokenSlugs: ["owner/repo"] });
    const r = await sourceAndRun2(h, config, 'echo "REQ=$REQUEST_REPOS PAT=[$PAT_FILES] ALLOWED=$ALLOWED"');
    expect(r.stdout.trim()).toBe("REQ=owner/repo PAT=[] ALLOWED=owner/repo");
    const file = await setupServed();
    const f = await sourceAndRun2(file.info, file.config, 'echo "REQ=[$REQUEST_REPOS] PAT=$PAT_FILES"');
    expect(f.stdout.trim()).toBe(`REQ=[] PAT=${file.info.gitTokenFiles["owner/repo"]}`);
  });

  it("scriptet AVBRYTER (exit 2) uten å røre runneren: request-repo uten token-fil, ulesbar fil, for åpne rettigheter; file-repo med token-fil", async () => {
    const req = await setupServed({ requestTokenSlugs: ["owner/repo"] });
    const none = abortRun(req.config, {});
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("ACCEPTANCE_GIT_TOKEN_FILE");
    expect(none.stderr).toContain("source=request");
    const unreadable = abortRun(req.config, { ACCEPTANCE_GIT_TOKEN_FILE: join(req.info.root, "finnes-ikke") });
    expect(unreadable.status).toBe(2);
    expect(unreadable.stderr).toContain("kan ikke lese ACCEPTANCE_GIT_TOKEN_FILE");
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666]) {
      const open = abortRun(req.config, { ACCEPTANCE_GIT_TOKEN_FILE: await tokenFile(req.info, mode) });
      expect(open.status, mode.toString(8)).toBe(2);
      expect(open.stderr).toContain("for åpne rettigheter");
      expect(open.stdout + open.stderr).not.toContain(REQUEST_TOKEN);
    }
    const file = await setupServed();
    const wrongMode = abortRun(file.config, { ACCEPTANCE_GIT_TOKEN_FILE: await tokenFile(file.info) });
    expect(wrongMode.status).toBe(2);
    expect(wrongMode.stderr).toContain("source=file");
    expect(wrongMode.stdout + wrongMode.stderr).not.toContain(REQUEST_TOKEN);
    expect((await req.health()).json.active_jobs).toBe(0);
    expect((await file.health()).json.active_jobs).toBe(0);
  });

  it("create_job og J11-stegene fungerer mot en `request`-runner med token fra filen; argv til curl OG node inneholder verken git-tokenet eller API-nøkkelen", async () => {
    const { info: h, config, health } = await setupServed({ requestTokenSlugs: ["owner/repo"] });
    const file = await tokenFile(h);
    const shims = await makeTempDir("wpc1-argvspy-");
    const log = join(shims, "argv.log");
    for (const name of ["curl", "node"]) {
      const real = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: { PATH: process.env["PATH"] } }).stdout.trim();
      await writeFile(join(shims, name), `#!/bin/sh\nprintf '%s\\0' "${name}" "$@" >> '${log}'\nprintf '\\n' >> '${log}'\nexec '${real}' "$@"\n`);
      await chmod(join(shims, name), 0o755);
    }
    const r = await sourceAndRun2(h, config, `
      create_job '{"ANTHROPIC_API_KEY":"${ANTHROPIC_DUMMY}"}'; echo "CREATE=$? HTTP=$HTTP_CODE"
      cexec 60000 sh -c "echo x > A.txt && git checkout -q -b jarvis/accept-test && git add -A && git commit -q -m t && git rev-parse HEAD"
      SHA="\${EXEC_OUT//$'\\n'/}"
      cexec 20000 sh -c 'printf "%s" "\${#ANTHROPIC_API_KEY}"'; echo "KEY_LENGTH_IN_CONTAINER=$EXEC_OUT"
      api POST "/v1/jobs/$JOB_ID/publish" "$(publish_body jarvis/accept-test)"; echo "PUBLISH=$HTTP_CODE SAME=$([ "$(resp_get commit_sha)" = "$SHA" ] && echo ja || echo nei)"
      api POST "/v1/jobs/$JOB_ID/publish" "$(publish_body main)"; echo "MAIN=$HTTP_CODE $(resp_get error)"
      delete_job "$JOB_ID"; echo "DELETE=$HTTP_CODE"
    `, { ACCEPTANCE_GIT_TOKEN_FILE: file, PATH: `${shims}:${process.env["PATH"]}` });
    expect(r.stderr).toBe("");
    const lines = r.stdout.trim().split("\n");
    expect(lines).toContain("CREATE=0 HTTP=201");
    expect(lines).toContain(`KEY_LENGTH_IN_CONTAINER=${ANTHROPIC_DUMMY.length}`); // nøkkelen kom frem i containeren (verdien selv er redigert i svaret, så lengden sammenlignes)
    expect(lines).toContain("PUBLISH=200 SAME=ja");
    expect(lines).toContain("MAIN=400 branch_invalid");
    expect(lines).toContain("DELETE=200");
    expect((await health()).json.active_jobs).toBe(0);
    // ingen hemmelighet i noens argv: spionene logget HVER curl- og node-kommando scriptet kjørte
    const argv = await readFile(log, "utf8");
    expect(argv.split("\n").filter(Boolean).length).toBeGreaterThan(8);
    expect(argv).not.toContain(REQUEST_TOKEN);
    expect(argv).not.toContain(REQUEST_TOKEN.slice(0, 24));
    expect(argv).not.toContain(ANTHROPIC_DUMMY);
    expect(argv).not.toContain("ghs_");
    expect(argv).toContain("--data-binary\u0000@"); // bodyen går via en fil
    // og runneren la tokenet på de to riktige stedene (klone og publish) - bevist ved at begge lyktes mot en runner som KREVER token
    expect(r.stdout).not.toContain(REQUEST_TOKEN);
  });

  it("J12 leter etter git-token-filens innhold i journalen (filen leses inn i hemmelighetslisten uten å skrives ut)", async () => {
    const text = await readFile(SCRIPT, "utf8");
    const j12 = text.slice(text.indexOf("check_J12()"), text.indexOf("check_J13()"));
    expect(j12).toContain('"$GIT_TOKEN_FILE"');
    expect(j12).toMatch(/tr -d '\\n' < "\$GIT_TOKEN_FILE" >> "\$WORK\/secrets"/);
  });
});

/** Som sourceAndRun i gruppe C, men med ekstra miljø og uten antakelser om repo-modus. */
async function sourceAndRun2(h, config, body, extraEnv = {}) {
  const program = `
    set -uo pipefail
    source "${SCRIPT}"
    REPO=owner/repo; STAMP=test; WORK="$(mktemp -d)"; chmod 700 "$WORK"
    CONFIG="${config}"; load_policy
    ( umask 077; printf 'Authorization: Bearer %s\\n' "$(tr -d '\\n' < "$TOKEN_FILE")" > "$WORK/auth.hdr" )
    ${body}
    rm -rf "$WORK"
  `;
  return spawnSync("bash", ["-c", program], { env: { ...baseEnv, ACCEPTANCE_SOURCE_ONLY: "1", ...extraEnv }, encoding: "utf8", timeout: 120_000 });
}
