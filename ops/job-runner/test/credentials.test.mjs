import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startGitSmartHttpServer } from "../../../modules/tasks/test/support/git-smart-http-server.ts";
import { credentialHelperArgs, FileGitCredentialSource, GIT_CREDENTIAL_TOKEN_ENV } from "../lib/credentials.mjs";
import { RunnerError } from "../lib/errors.mjs";
import { GIT_TOKEN, createHarness, gitSync } from "./support/harness.mjs";
import { startProbeServer } from "./support/probe-server.mjs";

/**
 * WP-C1: git-credentialen går ALDRI inn i jobb-containeren og leveres KUN til nøyaktig protokoll + vert + repo-sti
 * (runnerens egen credential-helper). Her testes helperen direkte, kilden, og ende-til-ende mot ekte git ↔ lokal HTTP.
 */

const HELPER = new URL("../credential-helper.mjs", import.meta.url).pathname;
const helper = (stdin, { args = ["https", "github.com", "owner/repo", "get"], token = GIT_TOKEN } = {}) =>
  spawnSync(process.execPath, [HELPER, ...args], { input: stdin, encoding: "utf8", env: { PATH: process.env["PATH"], ...(token === null ? {} : { JARVIS_GIT_CREDENTIAL_TOKEN: token }) } });

describe("A0: kanalnavnet er ett og samme begge steder", () => {
  it("helperens TOKEN_ENV er identisk med GIT_CREDENTIAL_TOKEN_ENV (runneren setter, helperen leser) og med worker-siden", async () => {
    const helperSource = await readFile(HELPER, "utf8");
    expect(helperSource).toContain(`const TOKEN_ENV = ${JSON.stringify(GIT_CREDENTIAL_TOKEN_ENV)};`);
    const workerSide = await readFile(new URL("../../../modules/tasks/src/git-auth.ts", import.meta.url), "utf8");
    expect(workerSide).toContain(`GIT_CREDENTIAL_TOKEN_ENV = ${JSON.stringify(GIT_CREDENTIAL_TOKEN_ENV)}`);
  });
});

describe("A: credential-helperen svarer KUN for nøyaktig scope", () => {
  it("riktig protokoll + vert + repo (med .git, stor/liten bokstav, ledende skråstrek) gir x-access-token + token", () => {
    for (const path of ["owner/repo", "owner/repo.git", "Owner/Repo.git", "/owner/repo"]) {
      const r = helper(`protocol=https\nhost=github.com\npath=${path}\n\n`);
      expect(r.status, path).toBe(0);
      expect(r.stdout, path).toBe(`username=x-access-token\npassword=${GIT_TOKEN}\n`);
    }
    expect(helper("protocol=https\nhost=GitHub.COM\npath=owner/repo.git\n\n").stdout).toContain("password=");
  });

  it("fremmed vert, annet repo, annen protokoll, port-avvik, manglende felt: ingen svar (git feiler lukket)", () => {
    const denied = [
      "protocol=https\nhost=evil.example\npath=owner/repo.git\n\n",
      "protocol=https\nhost=github.com.evil.example\npath=owner/repo.git\n\n",
      "protocol=https\nhost=github.com:8443\npath=owner/repo.git\n\n",
      "protocol=https\nhost=evil.example/github.com\npath=owner/repo.git\n\n",
      "protocol=https\nhost=github.com\npath=owner/annet.git\n\n",
      "protocol=https\nhost=github.com\npath=andre/repo.git\n\n",
      "protocol=https\nhost=github.com\npath=owner/repo/extra\n\n",
      "protocol=https\nhost=github.com\npath=owner/repo.git.evil\n\n",
      "protocol=https\nhost=github.com\n\n",
      "protocol=http\nhost=github.com\npath=owner/repo.git\n\n",
      "protocol=ssh\nhost=github.com\npath=owner/repo.git\n\n",
      "host=github.com\npath=owner/repo.git\n\n",
      "",
      "garbage",
      "protocol=https\nhost=github.com\npath=owner/repo.git\nprotocol=http\n\n" // senere linje overstyrer: nå «http» -> mismatch
    ];
    for (const input of denied) {
      const r = helper(input);
      expect(r.status, JSON.stringify(input)).toBe(0);
      expect(r.stdout, JSON.stringify(input)).toBe("");
    }
  });

  it("store/erase persisterer aldri noe; manglende/tomt token gir aldri et tomt passord; enorm input gir ingenting", () => {
    expect(helper("protocol=https\nhost=github.com\npath=owner/repo.git\n\n", { args: ["https", "github.com", "owner/repo", "store"] }).stdout).toBe("");
    expect(helper("protocol=https\nhost=github.com\npath=owner/repo.git\n\n", { args: ["https", "github.com", "owner/repo", "erase"] }).stdout).toBe("");
    expect(helper("protocol=https\nhost=github.com\npath=owner/repo.git\n\n", { token: null }).stdout).toBe("");
    expect(helper("protocol=https\nhost=github.com\npath=owner/repo.git\n\n", { token: "" }).stdout).toBe("");
    expect(helper(`protocol=https\nhost=github.com\npath=owner/repo.git\n${"x=".repeat(20_000)}\n\n`).stdout).toBe("");
  });
});

describe("B: credentialHelperArgs - ingen shell-metategn når git sin shell-snippet", () => {
  const base = { nodePath: "/usr/bin/node", helperScript: "/opt/jarvis-job-runner/ops/job-runner/credential-helper.mjs", scope: { protocol: /** @type {"https"} */ ("https"), host: "github.com", path: "owner/repo" } };

  it("nullstiller ambient helper-kjede, registrerer kun runnerens helper, scopet er innebakt, token er IKKE i argv", () => {
    const args = credentialHelperArgs(base);
    expect(args.slice(0, 2)).toEqual(["-c", "credential.helper="]);
    expect(args[3]).toBe("credential.helper=!'/usr/bin/node' '/opt/jarvis-job-runner/ops/job-runner/credential-helper.mjs' 'https' 'github.com' 'owner/repo'");
    expect(args).toContain("credential.useHttpPath=true");
    expect(args.join(" ")).not.toMatch(/token|ghp_/i);
  });

  it("avviser stier, verter og slugs med anførselstegn, mellomrom, $, `, ; eller linjeskift", () => {
    for (const bad of ["/usr/bin/no de", "/usr/bin/node'; rm -rf /; '", "/usr/bin/$(id)", "/usr/bin/node\n", "relative/node", "/usr/bin/`id`"]) {
      expect(() => credentialHelperArgs({ ...base, nodePath: bad }), bad).toThrow(RunnerError);
      expect(() => credentialHelperArgs({ ...base, helperScript: bad }), bad).toThrow(RunnerError);
    }
    for (const host of ["github.com'x", "git hub.com", "a;b", "github.com/x", "$(id).com"]) {
      expect(() => credentialHelperArgs({ ...base, scope: { ...base.scope, host } }), host).toThrow(RunnerError);
    }
    for (const path of ["owner/repo'x", "owner/re po", "owner", "owner/repo/extra", "../x/y", "owner/repo;id", "-x/y\n"]) {
      expect(() => credentialHelperArgs({ ...base, scope: { ...base.scope, path } }), path).toThrow(RunnerError);
    }
    // bevisst ugyldig protokoll
    expect(() => credentialHelperArgs({ ...base, scope: { ...base.scope, protocol: "ssh" } })).toThrow(RunnerError);
  });
});

describe("C: FileGitCredentialSource (PAT per repo, fil med strenge rettigheter)", () => {
  const make = async (mode, content = `${GIT_TOKEN}\n`) => {
    const dir = await mkdtemp(join(tmpdir(), "jr-cred-"));
    const file = join(dir, "pat");
    await writeFile(file, content);
    await chmod(file, mode);
    return { dir, file };
  };
  const source = (file) => new FileGitCredentialSource({ files: { "owner/repo": { tokenFile: file } } });
  const failure = async (promise) => { try { await promise; } catch (e) { return e; } return null; };

  it("returnerer token for konfigurert repo; roterer uten omstart; ukjent repo nektes", async () => {
    const { file } = await make(0o600);
    const s = source(file);
    expect(await s.tokenFor("owner/repo")).toBe(GIT_TOKEN);
    await writeFile(file, "ghp_RotertTokenNeverReal0123456789\n");
    expect(await s.tokenFor("owner/repo")).toBe("ghp_RotertTokenNeverReal0123456789");
    const unknown = await failure(s.tokenFor("owner/andre"));
    expect(unknown).toMatchObject({ code: "git_credential_unavailable", status: 403 });
    expect((await failure(s.tokenFor("__proto__")))?.code).toBe("git_credential_unavailable");
    expect((await failure(s.tokenFor("constructor")))?.code).toBe("git_credential_unavailable");
  });

  it("nekter åpne rettigheter, feil format og manglende fil - uten å lekke filinnhold i feilen", async () => {
    const open = await make(0o644, "ghp_AapenFilNeverReal0123456789\n");
    const e1 = await failure(source(open.file).tokenFor("owner/repo"));
    expect(e1).toMatchObject({ code: "git_credential_unavailable" });
    expect(JSON.stringify(e1)).not.toContain("ghp_AapenFil");
    const bad = await make(0o600, "token med mellomrom og æøå\n");
    expect(await failure(source(bad.file).tokenFor("owner/repo"))).toMatchObject({ code: "git_credential_unavailable", detail: "token_format_invalid" });
    const missing = new FileGitCredentialSource({ files: { "owner/repo": { tokenFile: join(bad.dir, "finnes-ikke") } } });
    expect(await failure(missing.tokenFor("owner/repo"))).toMatchObject({ code: "git_credential_unavailable" });
  });
});

describe("D: ende-til-ende mot ekte git ↔ lokal HTTP (produksjonens protokollrestriksjoner: kun én protokoll)", () => {
  let server; let harnesses = [];
  beforeAll(async () => {
    server = await startGitSmartHttpServer([{ user: "x-access-token", pass: GIT_TOKEN }]);
    server.createBareRepo("owner/repo.git");
    const seed = await mkdtemp(join(tmpdir(), "jr-seed3-"));
    gitSync(seed, ["init", "--quiet", "--initial-branch=main", "."]);
    gitSync(seed, ["commit", "--allow-empty", "-q", "-m", "c1"]);
    gitSync(seed, ["push", "--quiet", join(server.reposRoot, "owner/repo.git"), "main"]);
  });
  afterAll(async () => { await server?.close(); });
  afterEach(async () => { await Promise.all(harnesses.map((h) => h.close())); harnesses = []; });
  const harness = async (options) => { const h = await createHarness(options); harnesses.push(h); return h; };
  const host = () => new URL(server.url("x")).host;

  it("klone + publish autentiseres med runnerens credential; credentialen finnes ingen steder i arbeidsmappen, config, argv eller container", async () => {
    const h = await harness({ remote: { protocol: "http", host: host() } });
    const job = await h.createJob({ task_id: "task-http" });
    await h.exec(job.job_id, ["sh", "-c", "echo hello > ny.txt && git checkout -q -b jarvis/task-http && git add -A && git commit -q -m agent"]);
    const pub = await h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch: "jarvis/task-http" } });
    expect(pub.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(server.authenticatedUsernames.length).toBeGreaterThanOrEqual(3); // ls-remote, fetch, push
    expect(new Set(server.authenticatedUsernames)).toEqual(new Set(["x-access-token"]));
    expect(gitSync(join(server.reposRoot, "owner/repo.git"), ["rev-parse", "jarvis/task-http"])).toBe(pub.json.commit_sha);
    // token ingen steder
    const work = join(h.baseDir, job.job_id, "work");
    expect(await readFile(join(work, ".git", "config"), "utf8")).not.toContain(GIT_TOKEN);
    expect(await readFile(join(h.baseDir, job.job_id, "private", "base.git", "config"), "utf8")).not.toContain(GIT_TOKEN);
    const grep = spawnSync("grep", ["-rIl", GIT_TOKEN, h.baseDir], { encoding: "utf8" });
    expect(grep.stdout).toBe("");
    for (const call of h.fake.calls) {
      expect(call.args.join(" ")).not.toContain(GIT_TOKEN);
      expect(JSON.stringify(call.env)).not.toContain(GIT_TOKEN);
    }
    expect(h.logLines.join("\n")).not.toContain(GIT_TOKEN);
  });

  it("feil token hos runneren: klone feiler lukket (502 git_network_failed), ingen jobb, ingen rester, token ikke i feilen", async () => {
    const h = await harness({ remote: { protocol: "http", host: host() } });
    await writeFile(h.config.gitCredentials["owner/repo"].tokenFile, "ghp_FeilTokenNeverReal0123456789\n");
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("git_network_failed");
    expect(r.text).not.toContain("ghp_FeilToken");
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.fake.containers.size).toBe(0);
  });

  it("manglende credential-fil: jobben nektes FØR noe nettverkskall eller container (git_credential_unavailable)", async () => {
    const h = await harness({ remote: { protocol: "http", host: host() } });
    await chmod(h.config.gitCredentials["owner/repo"].tokenFile, 0o644);
    const before = server.authenticatedUsernames.length;
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("git_credential_unavailable");
    expect(server.authenticatedUsernames.length).toBe(before);
    expect(h.fake.calls.some((c) => c.args[0] === "create")).toBe(false);
  });
});

describe("E: credentialen følger aldri en redirect eller en annen vert (ekte git + ekte helper-prosess)", () => {
  let a; let b; let harnesses = [];
  beforeAll(async () => { a = await startProbeServer(); b = await startProbeServer(); });
  afterAll(() => { a?.stop(); b?.stop(); });
  afterEach(async () => { await Promise.all(harnesses.map((h) => h.close())); harnesses = []; });
  const harness = async (options) => { const h = await createHarness(options); harnesses.push(h); return h; };
  const wait = () => new Promise((r) => setTimeout(r, 250));

  it("URL peker på en ANNEN vert enn scopet: helperen svarer ikke -> verten ser aldri Authorization", async () => {
    // scope = A (127.0.0.1:A), men URL-en peker på B -> git spør om credential for host B -> helperen avviser
    const h = await harness({ remote: { protocol: "http", host: `127.0.0.1:${a.port}`, urlFor: () => `http://127.0.0.1:${b.port}/challenge/owner/repo.git` } });
    const beforeA = a.requests.length;
    const beforeB = b.requests.length;
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(502);
    await wait();
    const seen = b.requests.slice(beforeB).filter((q) => q.path.startsWith("/challenge/"));
    expect(seen.length).toBeGreaterThan(0);        // git nådde B og fikk utfordringen...
    expect(seen.every((q) => q.auth === false)).toBe(true); // ...men credentialen ble ALDRI sendt dit
    expect(a.requests.length).toBe(beforeA);
  });

  it("redirect fra riktig vert til en annen: git følger den ikke (http.followRedirects=false), credentialen når aldri den andre verten", async () => {
    const h = await harness({ remote: { protocol: "http", host: `127.0.0.1:${a.port}`, urlFor: () => `http://127.0.0.1:${a.port}/redirect/${b.port}/challenge/owner/repo.git` } });
    const before = b.requests.length;
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(502);
    await wait();
    expect(a.requests.some((q) => q.path.startsWith("/redirect/"))).toBe(true); // redirecten ble utstedt...
    expect(b.requests.slice(before)).toEqual([]);                               // ...men aldri fulgt
  });

  it("riktig vert men annen repo-sti enn scopet: ingen credential", async () => {
    const h = await harness({ remote: { protocol: "http", host: `127.0.0.1:${a.port}`, urlFor: () => `http://127.0.0.1:${a.port}/challenge/annet/repo.git` } });
    const before = a.requests.length;
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(502);
    await wait();
    const seen = a.requests.slice(before).filter((q) => q.path.startsWith("/challenge/annet"));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((q) => q.auth === false)).toBe(true);
  });
});
