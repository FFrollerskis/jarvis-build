import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostGit } from "../lib/git.mjs";
import { SecretRegistry } from "../lib/log.mjs";
import { createGitSpy } from "./support/git-spy.mjs";
import { GIT_TOKEN, createHarness, gitSync } from "./support/harness.mjs";
import { makeTempDir } from "./support/tmp.mjs";

/**
 * WP-C1: publish = bundle laget INNE I containeren -> verifisert på verten i et ferskt bare-repo -> push med runnerens credential.
 * Adversarielle tester: bundler med flere refs, feil prerequisite, for mange commits/filer, nektede stier, submodul, malformede
 * objekter (`.git` i tre), ikke-etterkommer, merge-commits, for stor, søppel/avkuttet, og en agent som planter hooks/config i /work.
 */

let harnesses = [];
const harness = async (options) => { const h = await createHarness(options); harnesses.push(h); return h; };
afterEach(async () => { await Promise.all(harnesses.map((h) => h.close())); harnesses = []; });

const publish = (h, id, branch = "jarvis/task-1") => h.api({ method: "POST", path: `/v1/jobs/${id}/publish`, body: { branch } });
const sh = (h, id, script) => h.exec(id, ["sh", "-c", script]);
const commitAs = (h, id, script) => sh(h, id, `${script} && git add -A && git commit -q -m agent`);
const refs = (dir) => gitSync(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).split("\n").filter(Boolean);

/** Lager en bundle fra en scratch-klone av origin (agentens «ondsinnede» side), og får runneren til å motta den som svar på `git bundle create`. */
async function craft(h, base, build) {
  const scratch = await makeTempDir("jr-craft-");
  gitSync(scratch, ["clone", "--quiet", h.origins["owner/repo"].dir, "."]);
  const revArgs = await build(scratch);
  const r = spawnSync("git", ["bundle", "create", "-", ...revArgs], { cwd: scratch, env: { PATH: process.env["PATH"], HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(`craft feilet: ${r.stderr}`);
  return { bundle: r.stdout, scratch, base };
}
const intercept = (h, bundleBytes) => {
  h.fake.state.onExec = ({ argv }) => (argv.includes("bundle") && argv.includes("create") ? { status: 0, stdout: Buffer.from(bundleBytes), stderr: Buffer.alloc(0) } : undefined);
};

describe("A: happy path og push-semantikk", () => {
  it("branch pushes med EXAKT den verifiserte committen; main og øvrige refs er urørt; ingen credential i origin", async () => {
    const h = await harness();
    const origin = h.origins["owner/repo"].dir;
    const before = refs(origin);
    const job = await h.createJob();
    expect((await commitAs(h, job.job_id, "echo hello > nytt.txt && git checkout -q -b jarvis/task-1")).json.code).toBe(0);
    const head = (await sh(h, job.job_id, "git rev-parse HEAD")).json.stdout.trim();
    const pub = await publish(h, job.job_id);
    expect(pub.status).toBe(200);
    expect(pub.json).toMatchObject({ branch: "jarvis/task-1", commit_sha: head, base_sha: job.head_sha, commits: 1, files_changed: 1 });
    const after = refs(origin);
    expect(after.filter((r) => !before.includes(r))).toEqual([`refs/heads/jarvis/task-1 ${head}`]);
    expect(before.every((r) => after.includes(r))).toBe(true); // main og alt annet uendret
    expect(gitSync(origin, ["log", "-1", "--format=%an <%ae>", "jarvis/task-1"])).toBe("jarvis-worker <worker@jarvis.local>");
    expect(await readFile(join(origin, "config"), "utf8")).not.toContain(h.gitToken);
    // verify-kopien og bundle-filen er ryddet
    expect(await readdir(join(h.baseDir, job.job_id, "private"))).toEqual(["base.git"]);
  });

  it("ingen endringer: 422 no_changes; ingen branch opprettes", async () => {
    const h = await harness();
    const origin = h.origins["owner/repo"].dir;
    const before = refs(origin);
    const job = await h.createJob();
    const pub = await publish(h, job.job_id);
    expect(pub.status).toBe(422);
    expect(pub.json.error).toBe("no_changes");
    expect(refs(origin)).toEqual(before);
  });

  it("samme commit publisert to ganger er idempotent (up to date); fast-forward til eksisterende jobb-branch går bra", async () => {
    const h = await harness();
    const job = await h.createJob();
    await commitAs(h, job.job_id, "echo 1 > a.txt");
    const p1 = await publish(h, job.job_id, "jarvis/ff");
    const p2 = await publish(h, job.job_id, "jarvis/ff");
    expect([p1.status, p2.status]).toEqual([200, 200]);
    expect(p2.json.commit_sha).toBe(p1.json.commit_sha);
    await commitAs(h, job.job_id, "echo 2 > b.txt");
    const p3 = await publish(h, job.job_id, "jarvis/ff");
    expect(p3.status).toBe(200);
    expect(p3.json.commits).toBe(2);
    expect(gitSync(h.origins["owner/repo"].dir, ["rev-parse", "jarvis/ff"])).toBe(p3.json.commit_sha);
  });

  it("aldri force: en eksisterende branch som ikke kan fast-forwardes avvises, og forblir uendret", async () => {
    const h = await harness();
    const origin = h.origins["owner/repo"].dir;
    // en «annen» historie ligger allerede på jarvis/taken
    const other = await makeTempDir("jr-other-");
    gitSync(other, ["init", "--quiet", "--initial-branch=main", "."]);
    gitSync(other, ["commit", "--allow-empty", "-q", "-m", "annen"]);
    gitSync(other, ["push", "--quiet", origin, "HEAD:refs/heads/jarvis/taken"]);
    const existing = gitSync(origin, ["rev-parse", "jarvis/taken"]);
    const job = await h.createJob();
    await commitAs(h, job.job_id, "echo 1 > a.txt");
    const pub = await publish(h, job.job_id, "jarvis/taken");
    expect(pub.status).toBe(502);
    expect(pub.json.error).toMatch(/push_(failed|rejected)/);
    expect(gitSync(origin, ["rev-parse", "jarvis/taken"])).toBe(existing);
  });

  it("kildekode: push-refspec har aldri + (force) eller tom kilde (sletting), og git push får aldri --force/--delete/--mirror", async () => {
    const src = await readFile(new URL("../lib/git.mjs", import.meta.url), "utf8");
    const pushArgs = /\["push",([^\]]*)\]/.exec(src)?.[1] ?? "";
    expect(pushArgs).toContain("--porcelain");
    expect(pushArgs).not.toMatch(/--force|-f\b|--delete|--mirror|--all|--tags|\+/);
    expect(src).toContain("`${sha}:refs/heads/${p.branch}`");
  });
});

describe("B: grenser og nektede stier (verifisert på verten, ikke stolt på fra containeren)", () => {
  it("for mange commits", async () => {
    const h = await harness({ runner: { publish: { max_commits: 2 } } });
    const job = await h.createJob();
    for (const n of [1, 2, 3]) await commitAs(h, job.job_id, `echo ${n} > f${n}.txt`);
    const pub = await publish(h, job.job_id);
    expect(pub.json).toMatchObject({ error: "bundle_too_many_commits" });
    expect(pub.status).toBe(422);
  });

  it("for mange filer", async () => {
    const h = await harness({ runner: { publish: { max_files: 3 } } });
    const job = await h.createJob();
    await commitAs(h, job.job_id, "for i in 1 2 3 4 5; do echo $i > f$i.txt; done");
    expect((await publish(h, job.job_id)).json.error).toBe("bundle_too_many_files");
  });

  it("for stor bundle (maks bytes)", async () => {
    const h = await harness({ runner: { publish: { max_bundle_bytes: 4096 } } });
    const job = await h.createJob();
    await commitAs(h, job.job_id, "head -c 40000 /dev/urandom > big.bin");
    const pub = await publish(h, job.job_id);
    expect(pub.status).toBe(422);
    expect(pub.json.error).toBe("bundle_too_large");
  });

  it("nektede stier: .github/, .gitmodules, .gitattributes - uansett skrivemåte (store/små bokstaver, usynlige tegn), også sletting", async () => {
    const h = await harness({ origins: { "owner/repo": { files: { ".github/workflows/base.yml": "name: base\n" } } } });
    const origin = h.origins["owner/repo"].dir;
    const zw = String.fromCharCode(0x200b); // usynlig tegn
    const cases = [
      ["mkdir -p .github/workflows && echo x > .github/workflows/ci.yml", ".github/"],
      ["mkdir -p .GitHub/Workflows && echo x > .GitHub/Workflows/ci.yml", ".github/"],
      [`mkdir -p ".gith${zw}ub/workflows" && echo x > ".gith${zw}ub/workflows/ci.yml"`, ".github/"],
      ["echo x >> .github/workflows/base.yml", ".github/"],
      ["git rm -q -r .github", ".github/"],
      ["printf '[submodule \"s\"]\\n\\tpath = s\\n\\turl = https://evil.example/x\\n' > .gitmodules", ".gitmodules"],
      ["echo '* filter=evil' > .gitattributes", ".gitattributes"],
      // A-F1 (review): nestede filer og .lfsconfig omgikk nektelisten (rot-`.gitattributes` ga 422, `src/.gitattributes` 200)
      ["mkdir -p src && echo '* linguist-generated=true -diff' > src/.gitattributes", ".gitattributes"],
      ["printf '[lfs]\\n\\turl = https://evil.example/lfs\\n' > .lfsconfig", ".lfsconfig"],
      ["mkdir -p a/b && echo x > a/b/.lfsconfig", ".lfsconfig"],
      ["mkdir -p pkg/.github/workflows && echo x > pkg/.github/workflows/ci.yml", ".github/"],
      ["mkdir -p sub && printf '[submodule \"s\"]\\n' > sub/.gitmodules", ".gitmodules"]
    ];
    for (const [script, rule] of cases) {
      const job = await h.createJob();
      await commitAs(h, job.job_id, script);
      const pub = await publish(h, job.job_id, `jarvis/t${Math.abs(script.length)}`);
      expect(pub.status, script).toBe(422);
      expect(pub.json.error, script).toBe("path_denied");
      expect(pub.json.detail ?? "", script).toContain(`matches_deny_list:${rule}`);
      await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    }
    expect(refs(origin).filter((r) => r.includes("jarvis/"))).toEqual([]); // ingenting pushet
  });

  it("A-F1: filer med LIGNENDE navn (foo.gitattributes.md, docs/gitmodules.txt, src/lfsconfig) publiseres - nektelisten treffer komponenter, ikke delstrenger", async () => {
    const h = await harness();
    const job = await h.createJob();
    await commitAs(h, job.job_id, "mkdir -p docs src && echo a > foo.gitattributes.md && echo b > docs/gitmodules.txt && echo c > src/lfsconfig && echo d > docs/gitattributes");
    const pub = await publish(h, job.job_id, "jarvis/lookalike");
    expect(pub.status).toBe(200);
    expect(pub.json.files_changed).toBe(4);
  });

  it("nektelisten er konfigurerbar (vertsadmin): en tillatt sti går gjennom, en ny nektet blokkeres", async () => {
    const h = await harness({ runner: { max_concurrent_jobs: 4, publish: { deny_paths: ["secrets/", "terraform"] } } });
    const a = await h.createJob();
    await commitAs(h, a.job_id, "mkdir -p .github && echo ok > .github/CODEOWNERS"); // .github er ikke lenger nektet her
    expect((await publish(h, a.job_id, "jarvis/allowed")).status).toBe(200);
    const b = await h.createJob();
    await commitAs(h, b.job_id, "mkdir -p secrets && echo x > secrets/k.txt");
    expect((await publish(h, b.job_id, "jarvis/denied1")).json.error).toBe("path_denied");
    const c = await h.createJob();
    await commitAs(h, c.job_id, "mkdir -p terraform && echo x > terraform/main.tf");
    expect((await publish(h, c.job_id, "jarvis/denied2")).json.error).toBe("path_denied");
  });

  it("submodul-endring (gitlink 160000) nektes", async () => {
    const h = await harness({ runner: { publish: { deny_paths: ["secrets/"] } } });
    const job = await h.createJob();
    await sh(h, job.job_id, "git update-index --add --cacheinfo 160000,0123456789012345678901234567890123456789,vendor/sub && git commit -q -m sub");
    const pub = await publish(h, job.job_id);
    expect(pub.status).toBe(422);
    expect(pub.json).toMatchObject({ error: "path_denied", detail: "submodule_changes_not_allowed" });
  });

  it("symlenker er vanlige tre-oppføringer (ikke fulgt på verten) - en lenke til /etc/passwd publiseres som lenke, ikke som innhold", async () => {
    const h = await harness();
    const job = await h.createJob();
    await commitAs(h, job.job_id, "ln -s /etc/passwd passwd-link");
    const pub = await publish(h, job.job_id);
    expect(pub.status).toBe(200);
    const blob = gitSync(h.origins["owner/repo"].dir, ["cat-file", "-p", `${pub.json.commit_sha}:passwd-link`]);
    expect(blob).toBe("/etc/passwd"); // selve lenkeblobben, aldri filinnholdet
  });
});

describe("C: bundler fra en ondsinnet agent (laget direkte, utenom runnerens egen `git bundle create`)", () => {
  it("flere refs i bundlen avvises", async () => {
    const h = await harness();
    const job = await h.createJob();
    const { bundle } = await craft(h, job.head_sha, async (s) => {
      gitSync(s, ["checkout", "-q", "-b", "a"]); gitSync(s, ["commit", "--allow-empty", "-q", "-m", "a"]);
      gitSync(s, ["checkout", "-q", "-b", "extra"]); gitSync(s, ["commit", "--allow-empty", "-q", "-m", "e"]);
      gitSync(s, ["checkout", "-q", "a"]);
      return [`${job.head_sha}..HEAD`, `${job.head_sha}..extra`];
    });
    intercept(h, bundle);
    const pub = await publish(h, job.job_id);
    expect(pub.json).toMatchObject({ error: "bundle_invalid", detail: "must_contain_exactly_one_ref_HEAD" });
  });

  it("feil prerequisite (bundlen bygger på agentens egen commit, ikke basen) avvises", async () => {
    const h = await harness();
    const job = await h.createJob();
    const { bundle } = await craft(h, job.head_sha, async (s) => {
      gitSync(s, ["commit", "--allow-empty", "-q", "-m", "ett"]); gitSync(s, ["commit", "--allow-empty", "-q", "-m", "to"]);
      return ["HEAD~1..HEAD"];
    });
    intercept(h, bundle);
    expect((await publish(h, job.job_id)).json).toMatchObject({ error: "bundle_invalid", detail: "prerequisite_must_be_the_base_commit" });
  });

  it("ingen prerequisite (hel ny historie / orphan) avvises", async () => {
    const h = await harness();
    const job = await h.createJob();
    await sh(h, job.job_id, "git checkout -q --orphan fresh && git rm -rq --cached . && echo x > only.txt && git add only.txt && git commit -q -m orphan");
    const pub = await publish(h, job.job_id);
    expect(pub.status).toBe(422);
    expect(pub.json.error).toBe("bundle_invalid");
  });

  it("merge-commits avvises (lineær historie kreves)", async () => {
    const h = await harness();
    const job = await h.createJob();
    await sh(h, job.job_id, "git checkout -q -b side && echo s > s.txt && git add -A && git commit -q -m side && git checkout -q - && echo m > m.txt && git add -A && git commit -q -m main2 && git merge -q --no-ff side -m merge");
    const pub = await publish(h, job.job_id);
    expect(pub.status).toBe(422);
    expect(pub.json).toMatchObject({ error: "bundle_invalid", detail: "merge_commits_not_allowed" });
  });

  it("malformert tre-objekt (oppføring kalt .git) stoppes av fsck --strict (git fetch fsck-er IKKE bundler)", async () => {
    const h = await harness();
    const job = await h.createJob();
    const { bundle } = await craft(h, job.head_sha, async (s) => {
      const blobSha = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: s, input: "x\n", encoding: "utf8", env: { PATH: process.env["PATH"], HOME: s, GIT_CONFIG_GLOBAL: "/dev/null" } }).stdout.trim();
      const raw = Buffer.concat([Buffer.from("100644 .git\0"), Buffer.from(blobSha, "hex")]);
      const tree = spawnSync("git", ["hash-object", "-t", "tree", "-w", "--stdin", "--literally"], { cwd: s, input: raw, env: { PATH: process.env["PATH"], HOME: s, GIT_CONFIG_GLOBAL: "/dev/null" } }).stdout.toString().trim();
      const commit = gitSync(s, ["commit-tree", tree, "-p", job.head_sha, "-m", "evil"]);
      gitSync(s, ["update-ref", "refs/heads/evil", commit]);
      gitSync(s, ["symbolic-ref", "HEAD", "refs/heads/evil"]);
      return [`${job.head_sha}..HEAD`];
    });
    intercept(h, bundle);
    const pub = await publish(h, job.job_id);
    expect(pub.status).toBe(422);
    expect(pub.json.error).toBe("bundle_fsck_failed");
    expect(refs(h.origins["owner/repo"].dir).some((r) => r.includes("jarvis/"))).toBe(false);
  });

  it("søppel, feil signatur, avkuttet pakke, manglende tom linje, enorm headerlinje og SHA-256-lignende hash avvises", async () => {
    const h = await harness();
    const job = await h.createJob();
    const { bundle } = await craft(h, job.head_sha, async (s) => { gitSync(s, ["commit", "--allow-empty", "-q", "-m", "ok"]); return [`${job.head_sha}..HEAD`]; });
    const sha = job.head_sha;
    const bad = {
      garbage: Buffer.from("dette er ikke en bundle"),
      emptyBytes: Buffer.alloc(0),
      v3: Buffer.concat([Buffer.from("# v3 git bundle\n"), bundle.subarray(bundle.indexOf("\n") + 1)]),
      truncatedPack: bundle.subarray(0, bundle.length - 25),
      noBlankLine: Buffer.from(`# v2 git bundle\n-${sha} x\n${"b".repeat(40)} HEAD\nPACK`),
      hugeLine: Buffer.concat([Buffer.from("# v2 git bundle\n"), Buffer.from(`-${sha} ${"x".repeat(10_000)}\n\n`), Buffer.from("PACK")]),
      sha256Hash: Buffer.from(`# v2 git bundle\n-${sha} x\n${"b".repeat(64)} HEAD\n\nPACK`),
      refWithSpaces: Buffer.from(`# v2 git bundle\n-${sha} x\n${"b".repeat(40)} HEAD extra\n\nPACK`),
      badPrereq: Buffer.from(`# v2 git bundle\n-${"z".repeat(40)} x\n${"b".repeat(40)} HEAD\n\nPACK`),
      noPackMagic: Buffer.from(`# v2 git bundle\n-${sha} x\n${"b".repeat(40)} HEAD\n\nNOTAPACK`),
      crlf: Buffer.from(`# v2 git bundle\r\n-${sha} x\r\n${"b".repeat(40)} HEAD\r\n\r\nPACK`)
    };
    for (const [name, bytes] of Object.entries(bad)) {
      intercept(h, bytes);
      const pub = await publish(h, job.job_id, "jarvis/bad");
      expect(pub.status, name).toBe(422);
      expect(pub.json.error, name).toMatch(/^(bundle_invalid|bundle_fetch_failed|bundle_fsck_failed|bundle_create_failed)$/);
    }
    h.fake.state.onExec = null;
    expect(refs(h.origins["owner/repo"].dir).some((r) => r.includes("jarvis/"))).toBe(false);
  });

  it("bundlen blir liggende som PAKKE i verify.git (aldri eksplodert til løse objekter): mange små objekter kan ikke tømme inoder", async () => {
    // git sin unbundle() kjører alltid `index-pack` (ikke unpack-objects). Testen låser antakelsen, siden en git-oppgradering som endrer den ville gjort en
    // hostil bundle med hundretusener av små objekter til hundretusener av filer på vertens volum.
    const h = await harness();
    const job = await h.createJob();
    const { bundle } = await craft(h, job.head_sha, async (s) => {
      for (let i = 0; i < 160; i += 1) await writeFile(join(s, `fil${i}.txt`), `innhold ${i}\n`);
      gitSync(s, ["add", "-A"]);
      gitSync(s, ["commit", "-q", "-m", "mange objekter"]);
      return [`${job.head_sha}..HEAD`];
    });
    const privateDir = join(h.baseDir, job.job_id, "private");
    const verifyDir = join(privateDir, "verify.git");
    await expect(h.service.manager.git.verifyAndPush({
      bundle, baseSha: job.head_sha, baseGitDir: join(privateDir, "base.git"), verifyDir, privateDir, slug: "owner/repo", branch: "jarvis/mange",
      identity: { name: "seed", email: "seed@test" }, limits: { maxCommits: 20, maxFiles: 5, denyPaths: [] }, timeoutMs: 60_000, token: GIT_TOKEN
    })).rejects.toMatchObject({ code: "bundle_too_many_files" }); // stopper ETTER fetch + fsck, og verify.git blir stående for inspeksjon
    const objects = join(verifyDir, "objects");
    expect((await readdir(objects)).filter((d) => /^[0-9a-f]{2}$/.test(d))).toEqual([]);
    expect((await readdir(join(objects, "pack"))).filter((f) => f.endsWith(".pack")).length).toBeGreaterThanOrEqual(1);
  });

  it("bundle-kommandoen feiler i containeren: 422 bundle_create_failed uten interne detaljer", async () => {
    const h = await harness();
    const job = await h.createJob();
    h.fake.state.onExec = ({ argv }) => (argv.includes("bundle") ? { status: 128, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: noe gikk galt") } : undefined);
    const pub = await publish(h, job.job_id);
    expect(pub.status).toBe(422);
    expect(pub.json.error).toBe("bundle_create_failed");
  });
});

describe("F: avkortet git-utdata er aldri «komplett» (A-F2)", () => {
  const ok = { status: 0, signal: null, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), timedOut: false, truncated: false, cancelled: false };
  const gitWith = (extra) => new HostGit({
    gitBin: "/usr/bin/git", nodePath: process.execPath, helperScript: "/x/helper.mjs", homeDir: tmpdir(), templateDir: tmpdir(),
    remote: { protocol: "https", host: "github.com" }, registry: new SecretRegistry(), run: async () => ({ ...ok, ...extra })
  });

  it("mustGit kaster git_output_truncated for ethvert trinn med kuttet utdata (også stderr), men ikke ved vanlig utdata; en feilet kommando beholder sin egen kode", async () => {
    await expect(gitWith({}).mustGit(["x"], {}, "steg_feilet", 422)).resolves.toMatchObject({ status: 0 });
    await expect(gitWith({ truncated: true }).mustGit(["x"], {}, "steg_feilet", 422)).rejects.toMatchObject({ code: "git_output_truncated", status: 422, detail: "steg_feilet" });
    await expect(gitWith({ truncated: true, stdout: Buffer.alloc(0), stderr: Buffer.from("støy") }).mustGit(["x"], {}, "steg_feilet", 502)).rejects.toMatchObject({ code: "git_output_truncated", status: 502 });
    await expect(gitWith({ truncated: true, status: 1 }).mustGit(["x"], {}, "steg_feilet", 422)).rejects.toMatchObject({ code: "steg_feilet", status: 422 });
    await expect(gitWith({ truncated: true, timedOut: true }).mustGit(["x"], {}, "steg_feilet", 422)).rejects.toMatchObject({ code: "steg_feilet_timeout" });
  });

  it("reviewerens angrep i liten skala (diff-taket senket): kuttpunktet faller FØR .github/workflows/evil.yml, og publish avvises i stedet for å tolke den avkortede listen som komplett", async () => {
    const h = await harness({ runner: { publish: { max_files: 20 } }, testOverrides: { diffEntryBytes: 120 } });
    const origin = h.origins["owner/repo"].dir;
    const job = await h.createJob();
    // 30 filer med 101 tegns navn sorterer FØR «.github» (`!` < `.`); taket er (20+1)*120+1 = 2521 byte, 201 byte per oppføring => ca. 12 oppføringer slipper inn, resten (og evil.yml) kuttes
    await commitAs(h, job.job_id, 'for i in $(seq 1 30); do echo $i > "!$(printf \'%0100d\' $i)"; done && mkdir -p .github/workflows && echo evil > .github/workflows/evil.yml');
    const pub = await publish(h, job.job_id, "jarvis/trunc");
    expect(pub.status).toBe(422);
    expect(pub.json).toMatchObject({ error: "bundle_too_many_files" });
    expect(pub.json.detail).toContain("diff_output_truncated");
    expect(refs(origin).some((r) => r.includes("jarvis/"))).toBe(false); // ingenting pushet
  });

  it("reviewerens ORIGINALE bundle (2150 filer med 4000 tegns navn + .github/workflows/evil.yml, max_files 20000): avvist med path_denied - før ga publish 200 og evil.yml lå på branchen", async () => {
    const h = await harness({ runner: { publish: { max_files: 20_000 } } });
    const origin = h.origins["owner/repo"].dir;
    const job = await h.createJob();
    const { bundle } = await craft(h, job.head_sha, async (s) => {
      const env = { PATH: process.env["PATH"], HOME: s, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", /* runnerens faste identitet: bundlen skal nå helt til nekteliste-trinnet (identitetssjekken A-F4 kommer før) */ GIT_AUTHOR_NAME: "jarvis-worker", GIT_AUTHOR_EMAIL: "worker@jarvis.local", GIT_COMMITTER_NAME: "jarvis-worker", GIT_COMMITTER_EMAIL: "worker@jarvis.local" };
      const run = (args, input) => { const r = spawnSync("git", args, { cwd: s, input, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
      const blob = run(["hash-object", "-w", "--stdin"], "x\n");
      const workflows = run(["mktree"], `100644 blob ${blob}\tevil.yml\n`);
      const dotGithub = run(["mktree"], `040000 tree ${workflows}\tworkflows\n`);
      const lines = [];
      for (let i = 0; i < 2150; i += 1) lines.push(`100644 blob ${blob}\t!${String(i).padStart(4000, "0")}`);
      lines.push(`040000 tree ${dotGithub}\t.github`);
      const tree = run(["mktree"], `${lines.join("\n")}\n`);
      const commit = run(["commit-tree", tree, "-p", job.head_sha, "-m", "evil"]);
      run(["update-ref", "refs/heads/evil", commit]);
      run(["symbolic-ref", "HEAD", "refs/heads/evil"]);
      return [`${job.head_sha}..HEAD`];
    });
    intercept(h, bundle);
    const pub = await publish(h, job.job_id, "jarvis/big");
    expect(pub.status).toBe(422);
    expect(pub.json).toMatchObject({ error: "path_denied", detail: "matches_deny_list:.github/" });
    expect(refs(origin).some((r) => r.includes("jarvis/"))).toBe(false);
  }, 120_000);

  it("diff-taket utledes av max_files: en diff innenfor grensen avkortes aldri (500 filer med lange stier publiseres), og for mange filer gir bundle_too_many_files", async () => {
    const h = await harness({ runner: { publish: { max_files: 500 } } });
    const job = await h.createJob();
    await commitAs(h, job.job_id, 'mkdir -p d && for i in $(seq 1 500); do echo $i > "d/$(printf \'%0200d\' $i)"; done');
    const pub = await publish(h, job.job_id, "jarvis/five-hundred");
    expect(pub.status).toBe(200);
    expect(pub.json.files_changed).toBe(500);
    const job2 = await h.createJob();
    await commitAs(h, job2.job_id, 'mkdir -p d && for i in $(seq 1 501); do echo $i > "d/$(printf \'%0200d\' $i)"; done');
    expect((await publish(h, job2.job_id, "jarvis/five-hundred-one")).json).toMatchObject({ error: "bundle_too_many_files", detail: "max=500" });
  }, 60_000);
});

describe("G: commit-identiteten er runnerens faste identitet (A-F4)", () => {
  const forged = [
    ["forfatternavn", "GIT_AUTHOR_NAME=Eva git commit -q -m x"],
    ["forfatter-e-post", "GIT_AUTHOR_EMAIL=eva@firma.no git commit -q -m x"],
    ["committer-navn", "GIT_COMMITTER_NAME=Eva git commit -q -m x"],
    ["committer-e-post", "GIT_COMMITTER_EMAIL=eva@firma.no git commit -q -m x"],
    ["--author", "git commit -q -m x --author='Eva <eva@firma.no>'"],
    ["identitet satt i git-config", "git -c user.name=Eva -c user.email=eva@firma.no commit -q -m x --author='Eva <eva@firma.no>'"]
  ];

  it("forfalsket forfatter eller committer (navn og e-post, alle veier) avvises med bundle_invalid / commit_identity_not_allowed - ingenting pushes", async () => {
    const h = await harness({ runner: { max_concurrent_jobs: 8 } });
    for (const [label, commit] of forged) {
      const job = await h.createJob();
      expect((await sh(h, job.job_id, `echo ${label.length} > f.txt && git add -A && ${commit}`)).json.code, label).toBe(0);
      const pub = await publish(h, job.job_id, `jarvis/forged-${label.length}`);
      expect(pub.status, label).toBe(422);
      expect(pub.json, label).toMatchObject({ error: "bundle_invalid", detail: "commit_identity_not_allowed" });
      await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    }
    expect(refs(h.origins["owner/repo"].dir).filter((r) => r.includes("jarvis/"))).toEqual([]);
  });

  it("EN forfalsket commit blant flere gode avvises (hele serien sjekkes); en serie med riktig identitet går gjennom", async () => {
    const h = await harness();
    const job = await h.createJob();
    await commitAs(h, job.job_id, "echo 1 > a.txt");
    await sh(h, job.job_id, "echo 2 > b.txt && git add -A && GIT_AUTHOR_NAME=Eva git commit -q -m forged");
    await commitAs(h, job.job_id, "echo 3 > c.txt");
    expect((await publish(h, job.job_id)).json).toMatchObject({ error: "bundle_invalid", detail: "commit_identity_not_allowed" });
    const ok = await h.createJob();
    await commitAs(h, ok.job_id, "echo 1 > a.txt");
    await commitAs(h, ok.job_id, "echo 2 > b.txt");
    const pub = await publish(h, ok.job_id, "jarvis/ok");
    expect(pub.status).toBe(200);
    expect(pub.json.commits).toBe(2);
  });

  it("identiteten er policy (runner.git_identity), ikke en konstant: med en annen konfigurert identitet går dens commits gjennom, og standardidentiteten er nå den forfalskede", async () => {
    const h = await harness({ runner: { git_identity: { name: "Annen Bot", email: "bot@firma.no" } } });
    const job = await h.createJob();
    await commitAs(h, job.job_id, "echo 1 > a.txt");
    expect((await publish(h, job.job_id, "jarvis/annen")).status).toBe(200);
    expect(gitSync(h.origins["owner/repo"].dir, ["log", "-1", "--format=%an <%ae> / %cn <%ce>", "jarvis/annen"])).toBe("Annen Bot <bot@firma.no> / Annen Bot <bot@firma.no>");
    const forgedJob = await h.createJob();
    await sh(h, forgedJob.job_id, "echo 2 > b.txt && git add -A && GIT_AUTHOR_NAME=jarvis-worker GIT_AUTHOR_EMAIL=worker@jarvis.local GIT_COMMITTER_NAME=jarvis-worker GIT_COMMITTER_EMAIL=worker@jarvis.local git commit -q -m x");
    expect((await publish(h, forgedJob.job_id, "jarvis/forfalsket")).json).toMatchObject({ detail: "commit_identity_not_allowed" });
  });

  it("en forfatter med skilletegnet (US, 0x1f) i navnet gir feil antall felt og avvises (fail-closed, ikke parset feil)", async () => {
    const h = await harness();
    const job = await h.createJob();
    await sh(h, job.job_id, "echo 1 > a.txt && git add -A && GIT_AUTHOR_NAME=\"$(printf 'jarvis-worker\\037x')\" git commit -q -m x");
    expect((await publish(h, job.job_id)).json).toMatchObject({ error: "bundle_invalid", detail: "commit_identity_not_allowed" });
  });
});

describe("H: bundle-trinnene (A-F10: mutanter M10, M46)", () => {
  it("M46: `git bundle create` i containeren kjøres med herdingsflaggene (ingen replace-objekter, hooks av, ingen protokoller, fsmonitor av) og nøyaktig dette argv-et", async () => {
    const h = await harness();
    const job = await h.createJob();
    await commitAs(h, job.job_id, "echo 1 > a.txt");
    let seen;
    h.fake.state.onExec = ({ argv }) => { if (argv.includes("bundle")) seen = argv; return undefined; };
    expect((await publish(h, job.job_id)).status).toBe(200);
    expect(seen).toEqual([
      "git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "core.fsmonitor=false",
      "bundle", "create", "-", `${job.head_sha}..HEAD`
    ]);
  });

  it("M10: SHA-en som faktisk ble hentet MÅ være den headeren lovet - avviker den, avvises bundlen (head_does_not_match_header) selv om fetch og fsck gikk bra", async () => {
    const h = await harness();
    const job = await h.createJob();
    const { bundle } = await craft(h, job.head_sha, async (s) => { gitSync(s, ["commit", "--allow-empty", "-q", "-m", "ok"]); return [`${job.head_sha}..HEAD`]; });
    const real = h.service.manager.git;
    const spoofed = Object.create(real);
    const realRun = real.run;
    spoofed.run = async (bin, args, options) => {
      if (args.includes("rev-parse") && args.includes("refs/jarvis/candidate^{commit}")) {
        return { status: 0, signal: null, stdout: Buffer.from(`${"0".repeat(40)}\n`), stderr: Buffer.alloc(0), timedOut: false, truncated: false, cancelled: false };
      }
      return realRun.call(real, bin, args, options);
    };
    const privateDir = join(h.baseDir, job.job_id, "private");
    const call = (git) => git.verifyAndPush({
      bundle, baseSha: job.head_sha, baseGitDir: join(privateDir, "base.git"), verifyDir: join(privateDir, "verify.git"), privateDir, slug: "owner/repo", branch: "jarvis/m10",
      identity: { name: "seed", email: "seed@test" }, limits: { maxCommits: 20, maxFiles: 5, denyPaths: [] }, timeoutMs: 60_000, token: GIT_TOKEN
    });
    await expect(call(spoofed)).rejects.toMatchObject({ code: "bundle_invalid", detail: "head_does_not_match_header" });
    expect(refs(h.origins["owner/repo"].dir).some((r) => r.includes("jarvis/"))).toBe(false);
  });
});

describe("I: git kjøres aldri i prosessens arbeidskatalog (A-F7)", () => {
  it("ls-remote (base-branch-oppslaget) kjører i det ferske, runner-eide base.git - ikke i arbeidskatalogen til runner-prosessen, der en .git ville blitt oppdaget og lest", async () => {
    const spy = await createGitSpy();
    const h = await harness({ runner: { git_bin: spy.gitBin } });
    const job = await h.createJob(); // uten base_branch -> ls-remote --symref
    const calls = await spy.calls();
    const lsRemote = calls.filter((c) => c.subcommand === "ls-remote");
    expect(lsRemote).toHaveLength(1);
    expect(lsRemote[0].cwd).toBe(join(h.baseDir, job.job_id, "private", "base.git"));
    // og INGEN git-kall (utenom --version-sjekkene ved oppstart) kjører i en katalog som ikke er jobbens eller runnerens egen
    for (const c of calls) {
      if (c.argv.includes("--version")) continue;
      expect(c.cwd.startsWith(h.baseDir), `${c.subcommand} i ${c.cwd}`).toBe(true);
    }
  });
});

describe("D: agenten planter hooks/config i /work - ingenting kjøres på VERTEN under publish", () => {
  /** Skriver en `.git/config` + hooks som ville kjørt en kommando hvis en host-git kjørte i katalogen. */
  async function plant(h, jobId, markerFile) {
    const work = join(h.baseDir, jobId, "work");
    const hooks = join(work, "hooks-evil");
    await mkdir(hooks, { recursive: true });
    const script = (name) => `#!/bin/sh\necho ${name} >> '${markerFile}'\n`;
    for (const hook of ["post-checkout", "pre-push", "reference-transaction", "pre-commit", "post-commit", "post-merge", "pre-auto-gc"]) {
      await writeFile(join(hooks, hook), script(hook), { mode: 0o755 });
    }
    await writeFile(join(work, "evil.sh"), script("config-command"), { mode: 0o755 });
    await writeFile(join(work, ".git", "evil-include"), `[core]\n\tfsmonitor = ${join(work, "evil.sh")}\n`);
    const config = [
      "[core]",
      `\thooksPath = ${hooks}`,
      `\tfsmonitor = ${join(work, "evil.sh")}`,
      `\tsshCommand = ${join(work, "evil.sh")}`,
      `\tpager = ${join(work, "evil.sh")}`,
      "[uploadpack]",
      `\tpackObjectsHook = ${join(work, "evil.sh")}`,
      "[credential]",
      `\thelper = !${join(work, "evil.sh")}`,
      "[diff]",
      `\texternal = ${join(work, "evil.sh")}`,
      "[url \"file:///does/not/exist/\"]",
      "\tinsteadOf = https://github.com/",
      "[include]",
      `\tpath = ${join(work, ".git", "evil-include")}`,
      "[gc]",
      "\tauto = 1",
      ""
    ].join("\n");
    const existing = await readFile(join(work, ".git", "config"), "utf8");
    await writeFile(join(work, ".git", "config"), existing + config);
    for (const hook of ["post-checkout", "pre-push", "reference-transaction", "post-commit", "post-merge", "pre-commit"]) {
      await mkdir(join(work, ".git", "hooks"), { recursive: true });
      await writeFile(join(work, ".git", "hooks", hook), script(`dot-git-hooks/${hook}`), { mode: 0o755 });
    }
    return work;
  }

  it("publish lykkes, og INGEN planter-nyttelast kjørte (markørfilen finnes ikke); runneren kjører aldri git i /work", async () => {
    const h = await harness();
    const marker = join(h.root, "MARKER-publish");
    const job = await h.createJob();
    await commitAs(h, job.job_id, "echo ok > fil.txt");
    await plant(h, job.job_id, marker);
    const pub = await publish(h, job.job_id);
    expect(pub.status).toBe(200);
    await expect(readFile(marker, "utf8")).rejects.toThrow(); // ingen nyttelast kjørte
    // og remoten fikk kun den ene committen (planter-konfigen påvirket ikke pushen: ingen insteadOf-omskriving)
    expect(gitSync(h.origins["owner/repo"].dir, ["rev-parse", "jarvis/task-1"])).toBe(pub.json.commit_sha);
  });

  it("positiv kontroll: samme planter-nyttelast KJØRER hvis git kjøres i katalogen (beviser at testen er diskriminerende)", async () => {
    const h = await harness();
    const marker = join(h.root, "MARKER-control");
    const job = await h.createJob();
    const work = await plant(h, job.job_id, marker);
    const env = { PATH: process.env["PATH"], HOME: h.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    spawnSync("git", ["status"], { cwd: work, env });                    // core.fsmonitor
    spawnSync("git", ["checkout", "-q", "-b", "kontroll"], { cwd: work, env }); // hooks (post-checkout / reference-transaction)
    const scratch = await makeTempDir("jr-ctl-");
    gitSync(scratch, ["init", "--quiet", "."]);
    spawnSync("git", ["fetch", "--quiet", work, "HEAD"], { cwd: scratch, env });    // uploadpack.packObjectsHook ved henting FRA agent-katalogen
    const fired = (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean);
    expect(fired.join(",")).toMatch(/config-command/);
    expect(fired.length).toBeGreaterThanOrEqual(2);
  });

  it("agenten bytter ut .git/config med en symlenke til en fil utenfor: runneren leser/skriver den aldri, og rydding følger ikke lenken", async () => {
    const h = await harness();
    const outside = join(h.root, "verts-hemmelighet.txt");
    await writeFile(outside, "VERTSHEMMELIGHET");
    const job = await h.createJob();
    await commitAs(h, job.job_id, "echo ok > fil.txt");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(h.baseDir, job.job_id, "work", "lenke-til-vertsfil"));
    await symlink(h.root, join(h.baseDir, job.job_id, "work", "lenke-til-rot"));
    expect((await publish(h, job.job_id)).status).toBe(200);
    expect((await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` })).status).toBe(200);
    expect(await readFile(outside, "utf8")).toBe("VERTSHEMMELIGHET");
  });
});

describe("E: kappløp og tilstand", () => {
  it("to samtidige publish på samme jobb: ett lykkes, det andre får 409 job_busy (aldri to pushes samtidig)", async () => {
    const h = await harness();
    const job = await h.createJob();
    await commitAs(h, job.job_id, "echo 1 > a.txt");
    const [a, b] = await Promise.all([publish(h, job.job_id, "jarvis/race"), publish(h, job.job_id, "jarvis/race")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("publish etter DELETE: 404; publish mens exec kjører: 409", async () => {
    const h = await harness();
    const job = await h.createJob();
    const slow = h.exec(job.job_id, ["sleep", "2"]);
    await new Promise((r) => setTimeout(r, 300));
    expect((await publish(h, job.job_id)).status).toBe(409);
    await slow;
    await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    expect((await publish(h, job.job_id)).status).toBe(404);
  }, 20_000);
});
