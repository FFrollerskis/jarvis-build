import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startGitSmartHttpServer } from "../../../modules/tasks/test/support/git-smart-http-server.ts";
import { RunnerError } from "../lib/errors.mjs";
import { createHarness, gitSync, syntheticInstallationToken } from "./support/harness.mjs";
import { makeTempDir } from "./support/tmp.mjs";

/**
 * WP-C1: grensen mot git-credential-KILDEN. Runneren eier `GitCredentialSource { tokenFor(repoSlug) -> Promise<string> }` (strukturelt lik
 * WP-C3 sin kontrakt, ikke importert), så en senere GitHub App-kilde kan injiseres uten å røre resten. Det som MÅ holde uansett kilde:
 *  - tokenFor kalles ved HVER klone og HVER publish (kortlevde tokens mellomlagres aldri),
 *  - svaret valideres (ingen linjeskift-/URL-/shell-tegn kommer til credential-protokollen eller env),
 *  - en kilde som feiler, kaster fremmede feil, henger eller svarer rart gir en LUKKET feil uten å gjengi kildens feilmelding.
 */

let harnesses = [];
afterEach(async () => { await Promise.all(harnesses.map((h) => h.close())); harnesses = []; });
const harness = async (options) => { const h = await createHarness(options); harnesses.push(h); return h; };
const GOOD = syntheticInstallationToken(300, 1);

/** Kilde som husker kallene sine. */
function recordingSource(impl) {
  const calls = [];
  return { calls, async tokenFor(slug) { calls.push(slug); return impl(slug, calls.length); } };
}

const COMMIT_AND_BRANCH = (branch) => ["sh", "-c", `echo hello > ny.txt && git checkout -q -b ${branch} && git add -A && git commit -q -m agent`];

describe("A: injisert kilde (file-remote; kilden er kun en port, tokenet brukes ikke av file://)", () => {
  it("tokenFor kalles med repo-slug ved HVER klone og HVER publish - aldri mellomlagret", async () => {
    const source = recordingSource(() => GOOD);
    const h = await harness({ credentials: source });
    const job = await h.createJob({ task_id: "t-a1" });
    expect(source.calls).toEqual(["owner/repo"]);
    await h.exec(job.job_id, COMMIT_AND_BRANCH("jarvis/t-a1"));
    const pub = await h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch: "jarvis/t-a1" } });
    expect(pub.status, pub.text).toBe(200);
    expect(source.calls).toEqual(["owner/repo", "owner/repo"]);
    // et nytt publish-forsøk (samme jobb) henter igjen
    await h.exec(job.job_id, ["sh", "-c", "echo mer >> ny.txt && git add -A && git commit -q -m mer"]);
    const again = await h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch: "jarvis/t-a1" } });
    expect(again.status, again.text).toBe(200);
    expect(source.calls).toHaveLength(3);
  });

  it("kilden får aldri se noe annet enn repo-sluggen (ikke env, token, sti eller task-id)", async () => {
    const seen = [];
    const source = { async tokenFor(...args) { seen.push(args); return GOOD; } };
    const h = await harness({ credentials: source });
    await h.createJob({ task_id: "t-a2", env: { MY_SETTING: "ikke-til-kilden" } });
    expect(seen).toEqual([["owner/repo"]]);
  });

  it("en kilde som kaster en FREMMED feil (med hemmelighet i meldingen) gir 502 git_credential_unavailable uten å gjengi meldingen; ingen rester", async () => {
    const secret = "ghp_KildeLekkerDetteNeverReal0123456789";
    const source = recordingSource(() => { throw new Error(`oppslag feilet for ${secret}`); });
    const h = await harness({ credentials: source });
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ error: "git_credential_unavailable", detail: "source_failed" });
    expect(r.text).not.toContain(secret);
    expect(h.logLines.join("\n")).not.toContain(secret);
    expect(h.logLines.join("\n")).toContain("git_credential_source_failed");
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.fake.containers.size).toBe(0);
  });

  it("en kilde som avviser med en RunnerError beholder sin egen kode og status (f.eks. repo ikke konfigurert = 403)", async () => {
    const source = recordingSource(() => { throw new RunnerError("git_credential_unavailable", 403, "repo_not_configured"); });
    const h = await harness({ credentials: source });
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: "git_credential_unavailable", detail: "repo_not_configured" });
  });

  it("en kilde som svarer med noe uvelformet nektes FØR git: linjeskift-injeksjon, URL-/shell-tegn, ikke-streng, tom, for lang", async () => {
    const bad = ["abcd1234\nhost=evil.example", "abcd1234\r\npassword=x", "tok en 12345", "abc:def@evil/x", "tok'en;rm", "", "kort", undefined, null, 12345678, {}, `ghs_${"a".repeat(8200)}`];
    for (const value of bad) {
      const source = recordingSource(() => value);
      const h = await harness({ credentials: source });
      const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
      expect(r.status, JSON.stringify(value)?.slice(0, 40)).toBe(502);
      expect(r.json).toMatchObject({ error: "git_credential_unavailable", detail: "token_format_invalid" });
      expect(h.service.manager.activeJobs).toBe(0);
      expect(h.fake.calls.some((c) => c.args[0] === "create")).toBe(false);
      await h.close();
      harnesses.pop();
    }
  });

  it("en kilde som HENGER gir 504 source_timeout innen tidsgrensen og frigjør jobbplassen (ingen hengende jobb)", async () => {
    const source = recordingSource(() => new Promise(() => undefined));
    const h = await harness({ credentials: source, tokenTimeoutMs: 200 });
    const started = Date.now();
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(504);
    expect(r.json).toMatchObject({ error: "git_credential_unavailable", detail: "source_timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("en kilde som feiler ETTER tidsgrensen gir aldri en ubehandlet rejection (prosessen overlever)", async () => {
    const unhandled = [];
    const listener = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const source = recordingSource(() => new Promise((_, reject) => setTimeout(() => reject(new Error("for sent")), 400)));
      const h = await harness({ credentials: source, tokenTimeoutMs: 100 });
      const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
      expect(r.status).toBe(504);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("feil ved PUBLISH (kilden svikter etter at jobben er opprettet): 502, ingen rester av verify.git, og jobben kan publiseres på nytt når kilden er frisk", async () => {
    let healthy = true;
    const source = recordingSource(() => { if (!healthy) throw new Error("midlertidig nede"); return GOOD; });
    const h = await harness({ credentials: source });
    const job = await h.createJob({ task_id: "t-a7" });
    await h.exec(job.job_id, COMMIT_AND_BRANCH("jarvis/t-a7"));
    healthy = false;
    const failed = await h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch: "jarvis/t-a7" } });
    expect(failed.status).toBe(502);
    expect(failed.json).toMatchObject({ error: "git_credential_unavailable", detail: "source_failed" });
    expect(h.service.manager.activeJobs).toBe(1); // jobben lever videre
    healthy = true;
    const ok = await h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch: "jarvis/t-a7" } });
    expect(ok.status, ok.text).toBe(200);
  });
});

describe("B: ende-til-ende med ekte git: det SISTE tokenet kilden gir brukes til pushen (bevis for ingen mellomlagring)", () => {
  let server;
  beforeAll(async () => {
    server = await startGitSmartHttpServer([{ user: "x-access-token", pass: GOOD }]);
    server.createBareRepo("owner/repo.git");
    const seed = await makeTempDir("jr-seed-src-");
    gitSync(seed, ["init", "--quiet", "--initial-branch=main", "."]);
    gitSync(seed, ["commit", "--allow-empty", "-q", "-m", "c1"]);
    gitSync(seed, ["push", "--quiet", join(server.reposRoot, "owner/repo.git"), "main"]);
  });
  afterAll(async () => { await server?.close(); });

  it("klone med gyldig token fra kilden, publish med et UGYLDIG (nytt) token -> pushen nektes av serveren; en mellomlagret kopi ville hatt suksess", async () => {
    const source = recordingSource((_slug, n) => (n === 1 ? GOOD : syntheticInstallationToken(300, 2)));
    const h = await harness({ credentials: source, remote: { protocol: "http", host: new URL(server.url("x")).host } });
    const job = await h.createJob({ task_id: "t-b1" });
    await h.exec(job.job_id, COMMIT_AND_BRANCH("jarvis/t-b1"));
    const pub = await h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch: "jarvis/t-b1" } });
    expect(source.calls).toHaveLength(2);
    expect(pub.status).toBe(502);
    expect(pub.json.error).toBe("push_failed");
    const remoteBranches = spawnSync("git", ["-C", join(server.reposRoot, "owner/repo.git"), "branch", "--list", "jarvis/t-b1"], { encoding: "utf8" });
    expect(remoteBranches.stdout.trim()).toBe(""); // ingenting ble pushet
    expect(pub.text).not.toContain(GOOD);
    expect(h.logLines.join("\n")).not.toContain(GOOD);
  });
});
