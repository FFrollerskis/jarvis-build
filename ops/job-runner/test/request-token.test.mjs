import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRequestToken, MAX_TOKEN_CHARS, MIN_REQUEST_TOKEN_CHARS, REQUEST_TOKEN_FORMAT } from "../lib/credentials.mjs";
import { SecretRegistry } from "../lib/log.mjs";
import { RUNNER_TOKEN, createHarness, gitSync, syntheticInstallationToken } from "./support/harness.mjs";
import { createGitSpy } from "./support/git-spy.mjs";
import { fingerprint, startTokenGitServer } from "./support/token-git-server.mjs";

/**
 * WP-C1 + WP-C3: kortlevd, repo-scopet git-token i JOBBFORESPØRSELEN (`git_token` i `POST /v1/jobs` og `POST /v1/jobs/:id/publish`).
 *
 * Tillitsmodellen (docs/runbooks/JOB_RUNNER.md kapittel 2): vertsadmin bestemmer PER REPO i den root-eide konfigen om worker får levere et token
 * (`git_credentials[repo].source = "request"`) eller om runneren bruker en PAT-fil (`file`, standard). Tokenet er bearer-autentisert over Unix-socketen,
 * gyldig for ÉN operasjon, aldri mellomlagret og aldri lagret i jobben, og det går ALDRI inn i jobb-containeren, arbeidsmappen, `.git/config`, argv,
 * loggen eller et svar - heller ikke når git selv skriver tokenet på stderr. Disse testene angriper nettopp det.
 */

let harnesses = [];
let servers = [];
afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  harnesses = [];
  for (const s of servers) s.stop();
  servers = [];
});
const harness = async (options) => { const h = await createHarness(options); harnesses.push(h); return h; };
const gitServer = async (options) => { const s = await startTokenGitServer(options); servers.push(s); return s; };

const TOKEN_A = syntheticInstallationToken(300, 1);
const TOKEN_B = syntheticInstallationToken(300, 2);
const REQ = { requestTokenSlugs: ["owner/repo"] };

const create = (h, token, extra = {}) => h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo", ...(token !== undefined ? { git_token: token } : {}), ...extra } });
const publish = (h, id, branch, token) => h.api({ method: "POST", path: `/v1/jobs/${id}/publish`, body: { branch, ...(token !== undefined ? { git_token: token } : {}) } });
const commit = (branch) => ["sh", "-c", `echo hello > ny.txt && git checkout -q -b ${branch} && git add -A && git commit -q -m agent`];
const wait = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};
const remoteOf = (server) => ({ protocol: /** @type {"http"} */ ("http"), host: server.host });

/** Rester en avvist forespørsel IKKE har lov til å etterlate: jobb, katalog, container, docker-kall. */
async function expectNoSideEffects(h) {
  expect(h.service.manager.activeJobs).toBe(0);
  expect(h.fake.containers.size).toBe(0);
  expect(h.fake.calls.some((c) => c.args[0] === "create" || c.args[0] === "start")).toBe(false);
  expect((await readdir(h.baseDir)).filter((n) => n !== ".runner")).toEqual([]);
}

/** Finnes tokenet NOEN STEDER det ikke skal? Logg, docker-kall (argv OG env), containere, jobbtilstand, filsystem, prosessmiljø. */
function expectNoLeak(h, token) {
  expect(h.logLines.join("\n"), "tjenestens logg").not.toContain(token);
  for (const call of h.fake.calls) {
    expect(call.args.join("\u0000"), "docker-argv").not.toContain(token);
    expect(JSON.stringify(call.env), "docker-env").not.toContain(token);
  }
  for (const c of h.fake.containers.values()) {
    expect(JSON.stringify({ env: c.env, argv: c.argv, labels: c.labels, mounts: c.mounts }), "container").not.toContain(token);
  }
  expect(JSON.stringify([...h.service.manager.jobs.values()]), "jobbtilstand i minnet").not.toContain(token);
  const grep = spawnSync("grep", ["-rlaF", "--", token, h.root, h.fake.home], { encoding: "utf8" });
  expect(grep.stdout, "filsystemet (base_dir, work/, private/, .runner/home, token-/PAT-filer)").toBe("");
  expect(Object.values(process.env).some((v) => typeof v === "string" && v.includes(token)), "prosessmiljø").toBe(false);
}

describe("A: formkontroll av git_token i API-laget (ingen bivirkninger, verdien ekkoes aldri)", () => {
  it("gyldig token i en forespørsel for et `request`-repo: 201; tokenet finnes ingen steder i tjenesten, containeren eller på disk", async () => {
    const h = await harness(REQ);
    const r = await create(h, TOKEN_A, { task_id: "t-a1", env: { MY_SETTING: "ikke-hemmelig-verdi" } });
    expect(r.status, r.text).toBe(201);
    expect(r.text).not.toContain(TOKEN_A);
    const id = r.json.job_id;
    const env = await h.exec(id, ["sh", "-c", "env"]);
    expect(env.status).toBe(200);
    expect(env.text).not.toContain(TOKEN_A);
    expect(env.json.stdout).not.toMatch(/JARVIS_GIT_CREDENTIAL_TOKEN|GITHUB_TOKEN|GH_TOKEN/);
    expectNoLeak(h, TOKEN_A);
    // sporbarhet (regel 4): hvilken kilde som ble brukt er merket i loggen, uten tokenet
    expect(h.logLines.find((l) => l.includes('"job_created"'))).toContain('"git_auth":"request"');
  });

  it("ugyldige verdier -> 400 git_token_invalid UTEN ekko og UTEN bivirkninger (ikke-streng, tom, kort, tegnsett, linjeskift-injeksjon, feil prefiks)", async () => {
    const h = await harness(REQ);
    const base = "a".repeat(30);
    const bad = [
      1234567890123456, true, false, null, [], ["ghs_aaaaaaaaaaaaaaaaaaaa"], { a: "ghs_aaaaaaaaaaaaaaaaaaaa" }, "", "ghs_", "ghs_abcd", `ghs_${"a".repeat(15)}`,
      // tegnsett: alt som kan endre meningen til credential-protokollen, env-overføringen eller en URL
      `ghs_${base}\n`, `ghs_${base}\r\nhost=evil.example`, `ghs_${base}\nusername=x`, `ghs_${base} x`, ` ghs_${base}`, `ghs_${base}\t`, `ghs_${base}:x`, `ghs_${base}@evil`,
      `ghs_${base}/x`, `ghs_${base}'`, `ghs_${base}"`, `ghs_${base}\\`, `ghs_${base}%41`, `ghs_${base}\u0000`, `ghs_${base}å`, `ghs_${base}$(id)`, `ghs_${base}\`id\``,
      `ghs_${base};id`, `ghs_${base}|id`, `ghs_${base}&id`, `ghs_${base}<x`, `ghs_${base}>x`, `ghs_${base}*`, `ghs_${base}?`, `ghs_${base}=`, `ghs_${base}~`, `ghs_${base}!`, `ghs_${base}#`,
      // feil prefiks: en ANNEN hemmelighet worker ved en feil sender skal aldri bli et passord til github.com
      `sk-ant-api03-${"a".repeat(80)}`, RUNNER_TOKEN, `${"a".repeat(40)}`, `GHS_${base}`, `Ghs_${base}`, `xghs_${base}`, `ghs-${base}`, `gho_${base}`, `ghu_${base}`,
      `github_pat${base}`, `Bearer ghs_${base}`, `token ghs_${base}`, `x-access-token:ghs_${base}`, `sk-${base}`, "xoxb-" + base,
      `ghs_${"a".repeat(MAX_TOKEN_CHARS - 3)}` // 8193 tegn
    ];
    for (const value of bad) {
      const r = await create(h, value);
      const label = JSON.stringify(value)?.slice(0, 60);
      expect(r.status, label).toBe(400);
      expect(r.json, label).toMatchObject({ error: "git_token_invalid" });
      if (typeof value === "string" && value.length >= 12) {
        expect(r.text, label).not.toContain(value.trim().slice(0, 12));
      }
      const p = await publish(h, "00000000-0000-4000-8000-000000000000", "jarvis/x", value);
      expect([400, 404], label).toContain(p.status); // ukjent jobb kan gi 404, men aldri en akseptert/echoet verdi
      if (typeof value === "string" && value.length >= 12) expect(p.text, label).not.toContain(value.trim().slice(0, 12));
    }
    await expectNoSideEffects(h);
  });

  it("yttergrensene: 20 tegn er minimum, 8192 maksimum (begge godtas), 19 og 8193 avvises", async () => {
    expect(MIN_REQUEST_TOKEN_CHARS).toBe(20);
    const h = await harness({ ...REQ, runner: { max_body_bytes: 65536 } });
    const min = `ghs_${"a".repeat(MIN_REQUEST_TOKEN_CHARS - 4)}`;
    const max = `ghs_${"a".repeat(MAX_TOKEN_CHARS - 4)}`;
    expect(min).toHaveLength(20);
    expect(max).toHaveLength(8192);
    expect((await create(h, `ghs_${"a".repeat(15)}`)).json).toMatchObject({ error: "git_token_invalid", detail: "too_short" });
    expect((await create(h, `${max}a`)).json).toMatchObject({ error: "git_token_invalid", detail: "too_long" });
    const ok1 = await create(h, min);
    expect(ok1.status, ok1.text).toBe(201);
    const ok2 = await create(h, max);
    expect(ok2.status, ok2.text).toBe(201);
    expectNoLeak(h, max);
    expectNoLeak(h, min);
  });

  it("alle tre GitHub-prefikser godtas (installasjonstoken ghs_, klassisk PAT ghp_, fine-grained PAT github_pat_); ingen andre", () => {
    for (const prefix of ["ghs_", "ghp_", "github_pat_"]) {
      expect(assertRequestToken(`${prefix}${"a1B2".repeat(8)}`)).toContain(prefix);
    }
    expect(REQUEST_TOKEN_FORMAT.test("ghs_12345678")).toBe(true);
    // andre leverandørers tokenformer bygges ved kjøring (ingen ekte-lignende litteraler i kildekoden som hemmelighetsskanneren må unnta)
    const other = [["gl", "pat-"], ["AK", "IA"]].map(([a, b]) => `${a}${b}${"1234567890".repeat(2)}`);
    for (const bad of ["gho_12345678901234567890", "ghu_12345678901234567890", "ghr_12345678901234567890", ...other]) {
      expect(() => assertRequestToken(bad), bad).toThrow(expect.objectContaining({ code: "git_token_invalid", status: 400 }));
    }
  });

  it("andre feltnavn for en credential er ukjente felt (ingen bakdør via gitToken/token/password/authorization ...), og detaljen er kun feltnavnet", async () => {
    const h = await harness(REQ);
    for (const key of ["gitToken", "token", "GIT_TOKEN", "git-token", "Git_Token", "git_token ", "git_credential", "credential", "credentials", "authorization", "password", "github_token", "pat", "x-access-token", "__proto__", "constructor"]) {
      const r = await h.api({ method: "POST", path: "/v1/jobs", rawBody: `{"repo":"owner/repo","${key}":"${TOKEN_A}"}` });
      expect(r.status, key).toBe(400);
      expect(r.json.error, key).toBe("unknown_field");
      expect(r.text, key).not.toContain(TOKEN_A);
    }
    await expectNoSideEffects(h);
  });

  it("git_token tas IKKE imot på exec, DELETE eller health: exec = ukjent felt, resten = ingen body tillatt", async () => {
    const h = await harness(REQ);
    const job = await create(h, TOKEN_A);
    const id = job.json.job_id;
    const e = await h.api({ method: "POST", path: `/v1/jobs/${id}/exec`, body: { argv: ["true"], git_token: TOKEN_A } });
    expect(e.status).toBe(400);
    expect(e.json.error).toBe("unknown_field");
    const d = await h.api({ method: "DELETE", path: `/v1/jobs/${id}`, body: { git_token: TOKEN_A } });
    expect(d.status).toBe(400);
    expect(d.json.error).toBe("body_not_allowed");
    const g = await h.api({ method: "GET", path: "/v1/health", body: { git_token: TOKEN_A } });
    expect(g.status).toBe(400);
    for (const r of [e, d, g]) expect(r.text).not.toContain(TOKEN_A);
    expect(h.service.manager.jobs.has(id)).toBe(true); // jobben ble ikke berørt av de avviste kallene
  });

  it("samme token i `env` ville havnet i jobb-containeren: avvist (git_token_in_env) FØR noe opprettes - også når det kun er en del av en lengre env-verdi", async () => {
    const h = await harness(REQ);
    for (const value of [TOKEN_A, `prefiks-${TOKEN_A}`, `${TOKEN_A}-suffiks`, `a ${TOKEN_A} b`]) {
      const r = await create(h, TOKEN_A, { env: { SOMETHING: value } });
      expect(r.status, value.slice(0, 20)).toBe(400);
      expect(r.json.error).toBe("git_token_in_env");
      expect(r.text).not.toContain(TOKEN_A);
    }
    await expectNoSideEffects(h);
    // et ANNET token i env er ikke dette tokenet (kun nøyaktig samme verdi er en identifiserbar lekkasje)
    const other = await create(h, TOKEN_A, { env: { SOMETHING: TOKEN_B } });
    expect(other.status, other.text).toBe(201);
  });

  it("uautentisert / feil bearer / feil content-type / ugyldig JSON / for stor body: ingen ekko, ingen bivirkninger", async () => {
    const h = await harness({ ...REQ, runner: { max_body_bytes: 4096 } });
    const body = { repo: "owner/repo", git_token: TOKEN_A };
    const none = await h.api({ method: "POST", path: "/v1/jobs", body, token: null });
    expect(none.status).toBe(401);
    const wrong = await h.api({ method: "POST", path: "/v1/jobs", body, token: "feil-token-feil-token-feil-token-feil-token" });
    expect(wrong.status).toBe(401);
    const plain = await h.api({ method: "POST", path: "/v1/jobs", rawBody: JSON.stringify(body), headers: { "content-type": "text/plain" } });
    expect(plain.status).toBe(415);
    const broken = await h.api({ method: "POST", path: "/v1/jobs", rawBody: `{"repo":"owner/repo","git_token":"${TOKEN_A}"` });
    expect(broken.status).toBe(400);
    expect(broken.json.error).toBe("invalid_json");
    const huge = await h.api({ method: "POST", path: "/v1/jobs", rawBody: JSON.stringify({ ...body, task_id: "x".repeat(5000) }) });
    expect(huge.status).toBe(413);
    for (const r of [none, wrong, plain, broken, huge]) expect(r.text).not.toContain(TOKEN_A);
    await expectNoSideEffects(h);
    expect(h.logLines.join("\n")).not.toContain(TOKEN_A);
  });
});

describe("B: policy per repo - vertsadmin bestemmer, aldri klienten (fail-closed, før noe reserveres)", () => {
  it("`request`-repo uten token: 400 git_token_required; ingen jobb, katalog, container, docker eller nettverk", async () => {
    const server = await gitServer({ accepted: [{ pass: TOKEN_A }] });
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...REQ, remote: remoteOf(server) });
    const r = await create(h, undefined, { task_id: "t-b1" });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "git_token_required" });
    await expectNoSideEffects(h);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.events).toEqual([]); // ikke et eneste nettverkskall
  });

  it("`file`-repo (standard) NEKTER et token i forespørselen: 403 git_token_not_accepted - worker kan ikke levere credentials uten at vertsadmin har åpnet for det", async () => {
    const server = await gitServer({ accepted: [{ pass: TOKEN_A }] });
    server.createBareRepo("owner/repo.git");
    const h = await harness({ remote: remoteOf(server) }); // standard = file
    const r = await create(h, TOKEN_A);
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: "git_token_not_accepted" });
    expect(r.text).not.toContain(TOKEN_A);
    await expectNoSideEffects(h);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.events).toEqual([]);
    expectNoLeak(h, TOKEN_A);
  });

  it("blandet konfig: hvert repo følger sin EGEN kilde (alle fire kombinasjoner)", async () => {
    const h = await harness({ slugs: ["owner/req", "owner/file"], requestTokenSlugs: ["owner/req"] });
    const call = (repo, token) => h.api({ method: "POST", path: "/v1/jobs", body: { repo, ...(token ? { git_token: token } : {}) } });
    expect((await call("owner/req", TOKEN_A)).status).toBe(201);
    expect((await call("owner/req")).json.error).toBe("git_token_required");
    expect((await call("owner/file")).status).toBe(201);
    expect((await call("owner/file", TOKEN_A)).json.error).toBe("git_token_not_accepted");
  });

  it("repo-navnet normaliseres FØR policyen slår opp (Owner/REPO kan ikke omgå kilden)", async () => {
    const h = await harness(REQ);
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "OWNER/Repo" } });
    expect(r.json).toMatchObject({ error: "git_token_required" });
    const ok = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "OWNER/Repo", git_token: TOKEN_A } });
    expect(ok.status, ok.text).toBe(201);
  });

  it("ukjent repo: repo_not_allowed (403) går foran token-sjekkene, og et token ekkoes ikke", async () => {
    const h = await harness(REQ);
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "annen/repo", git_token: TOKEN_A } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("repo_not_allowed");
    expect(r.text).not.toContain(TOKEN_A);
  });

  it("PUBLISH uten token på et `request`-repo: 400 git_token_required FØR containeren røres; jobben er uskadd og kan publiseres med et token", async () => {
    const h = await harness(REQ);
    const job = (await create(h, TOKEN_A, { task_id: "t-b6" })).json;
    await h.exec(job.job_id, commit("jarvis/t-b6"));
    const execsBefore = h.fake.calls.filter((c) => c.args[0] === "exec").length;
    const denied = await publish(h, job.job_id, "jarvis/t-b6");
    expect(denied.status).toBe(400);
    expect(denied.json).toMatchObject({ error: "git_token_required" });
    expect(h.fake.calls.filter((c) => c.args[0] === "exec").length).toBe(execsBefore); // ikke engang bundle-steget kjørte
    expect(h.service.manager.jobs.get(job.job_id).busy).toBe(null);
    const ok = await publish(h, job.job_id, "jarvis/t-b6", TOKEN_B);
    expect(ok.status, ok.text).toBe(200);
  });

  it("tokenet fra KLONINGEN gjenbrukes aldri til publish (ikke mellomlagret, ikke i jobbtilstanden): uten nytt token er publish nektet", async () => {
    const h = await harness(REQ);
    const job = (await create(h, TOKEN_A)).json;
    const state = h.service.manager.jobs.get(job.job_id);
    expect(JSON.stringify(state)).not.toContain(TOKEN_A);
    expect(state.secretValues).not.toContain(TOKEN_A); // jobbens hemmelighetsliste (env-verdier som avfinnes ved sletting) inneholder aldri git-tokenet
    expect(Object.keys(state).some((k) => /^git_?token$|credential/i.test(k))).toBe(false);
    await h.exec(job.job_id, commit("jarvis/t-b7"));
    const r = await publish(h, job.job_id, "jarvis/t-b7");
    expect(r.json.error).toBe("git_token_required");
  });

  it("PUBLISH med token på et `file`-repo: 403 git_token_not_accepted; jobben er uskadd og kan publiseres uten token", async () => {
    const h = await harness();
    const job = await h.createJob({ task_id: "t-b8" });
    await h.exec(job.job_id, commit("jarvis/t-b8"));
    const denied = await publish(h, job.job_id, "jarvis/t-b8", TOKEN_A);
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe("git_token_not_accepted");
    expect(denied.text).not.toContain(TOKEN_A);
    const ok = await publish(h, job.job_id, "jarvis/t-b8");
    expect(ok.status, ok.text).toBe(200);
  });

  it("den injiserte (vertsside) kilden kalles ALDRI for et `request`-repo, og et request-token når aldri en vertsside kilde for et `file`-repo", async () => {
    const calls = [];
    const source = { async tokenFor(slug) { calls.push(slug); return syntheticInstallationToken(300, 9); } };
    const h = await harness({ slugs: ["owner/req", "owner/file"], requestTokenSlugs: ["owner/req"], credentials: source });
    expect((await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/req", git_token: TOKEN_A } })).status).toBe(201);
    expect(calls).toEqual([]);
    expect((await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/file", git_token: TOKEN_A } })).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/file" } })).status).toBe(201);
    expect(calls).toEqual(["owner/file"]);
  });
});

describe("C: ende-til-ende med EKTE git mot en autentiserende smart-HTTP-server (token-fingeravtrykk per operasjon)", () => {
  it("klone med token A, publish med et NYTT token B: alle klone-kall bruker A, alle push-kall bruker B - aldri omvendt, aldri A til push", async () => {
    const server = await gitServer({ accepted: [{ pass: TOKEN_A }, { pass: TOKEN_B }] });
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...REQ, remote: remoteOf(server) });
    const created = await create(h, TOKEN_A, { task_id: "t-c1" });
    expect(created.status, created.text).toBe(201);
    const id = created.json.job_id;
    await h.exec(id, commit("jarvis/t-c1"));
    const pub = await publish(h, id, "jarvis/t-c1", TOKEN_B);
    expect(pub.status, pub.text).toBe(200);
    await wait(() => server.events.some((e) => e.op === "push"));
    const fetches = server.events.filter((e) => e.ev === "auth" && e.op === "fetch");
    const pushes = server.events.filter((e) => e.ev === "auth" && e.op === "push");
    expect(fetches.length).toBeGreaterThan(0);
    expect(pushes.length).toBeGreaterThan(0);
    expect(new Set(fetches.map((e) => e.h))).toEqual(new Set([fingerprint(TOKEN_A)]));
    expect(new Set(pushes.map((e) => e.h))).toEqual(new Set([fingerprint(TOKEN_B)]));
    expect(gitSync(join(server.reposRoot, "owner/repo.git"), ["rev-parse", "jarvis/t-c1"])).toBe(pub.json.commit_sha);
    expectNoLeak(h, TOKEN_A);
    expectNoLeak(h, TOKEN_B);
    expect(pub.text).not.toContain(TOKEN_B);
    expect(h.logLines.find((l) => l.includes('"job_published"'))).toContain('"git_auth":"request"');
  });

  it("minste eksponering (git-innpakning): tokenet står ALDRI i argv og leveres KUN til nettverkskallene ls-remote/fetch/push - ikke til init, lokal klone, fsck, rev-list ...", async () => {
    const spy = await createGitSpy();
    const server = await gitServer({ accepted: [{ pass: TOKEN_A }, { pass: TOKEN_B }] });
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...REQ, remote: remoteOf(server), runner: { git_bin: spy.gitBin } });
    const id = (await create(h, TOKEN_A, { task_id: "t-c2" })).json.job_id;
    await h.exec(id, commit("jarvis/t-c2"));
    expect((await publish(h, id, "jarvis/t-c2", TOKEN_B)).status).toBe(200);
    const calls = await spy.calls();
    expect(calls.length).toBeGreaterThan(8);
    for (const c of calls) {
      expect(c.argv.join("\n"), c.subcommand).not.toContain(TOKEN_A);
      expect(c.argv.join("\n"), c.subcommand).not.toContain(TOKEN_B);
      expect(c.argv.join("\n"), c.subcommand).not.toMatch(/x-access-token|ghs_|Authorization/i);
    }
    const carrying = calls.filter((c) => c.tokenHash !== null);
    expect(carrying.length).toBeGreaterThanOrEqual(3);
    expect(new Set(carrying.map((c) => c.subcommand))).toEqual(new Set(["ls-remote", "fetch", "push"]));
    // kloning: ls-remote + fetch = A; publisering: push = B
    expect(carrying.filter((c) => c.subcommand !== "push").every((c) => c.tokenHash === fingerprint(TOKEN_A))).toBe(true);
    expect(carrying.filter((c) => c.subcommand === "push").every((c) => c.tokenHash === fingerprint(TOKEN_B))).toBe(true);
    // alt annet (init, clone, remote, symbolic-ref, rev-parse, fsck, merge-base, rev-list, diff-tree, lokal bundle-fetch) fikk INGET token
    const bare = calls.filter((c) => c.tokenHash === null);
    for (const sub of ["init", "clone", "fsck", "rev-list", "diff-tree"]) expect(bare.some((c) => c.subcommand === sub), sub).toBe(true);
    for (const c of bare) if (c.subcommand === "fetch") expect(c.argv.join(" ")).toMatch(/out\.bundle/); // den lokale bundle-fetchen, ikke nettverket
  });

  it("feil token ved KLONING: 502 git_network_failed, ingen jobb, ingen rester, serveren så et avvist forsøk, og tokenet er ingen steder", async () => {
    const server = await gitServer({ accepted: [{ pass: TOKEN_A }] });
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...REQ, remote: remoteOf(server) });
    const baseline = h.registry.size;
    const r = await create(h, TOKEN_B);
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("git_network_failed");
    expect(r.text).not.toContain(TOKEN_B);
    await expectNoSideEffects(h);
    await wait(() => server.events.some((e) => e.ev === "denied" && e.withAuth));
    const denied = server.events.filter((e) => e.ev === "denied" && e.withAuth);
    expect(denied.length).toBeGreaterThan(0);
    expect(new Set(denied.map((e) => e.h))).toEqual(new Set([fingerprint(TOKEN_B)]));
    expect(server.events.some((e) => e.ev === "auth")).toBe(false);
    expectNoLeak(h, TOKEN_B);
    expect(h.registry.size).toBe(baseline); // det feilede tokenet ble frigjort
  });

  it("feil token ved PUBLISH: 502 push_failed, ingenting pushet; jobben lever og kan publiseres på nytt med riktig token", async () => {
    const server = await gitServer({ accepted: [{ pass: TOKEN_A }] });
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...REQ, remote: remoteOf(server) });
    const id = (await create(h, TOKEN_A)).json.job_id;
    await h.exec(id, commit("jarvis/t-c4"));
    const bad = await publish(h, id, "jarvis/t-c4", TOKEN_B);
    expect(bad.status).toBe(502);
    expect(bad.json.error).toBe("push_failed");
    expect(bad.text).not.toContain(TOKEN_B);
    expect(spawnSync("git", ["-C", join(server.reposRoot, "owner/repo.git"), "branch", "--list", "jarvis/t-c4"], { encoding: "utf8" }).stdout.trim()).toBe("");
    expect(h.service.manager.jobs.get(id).busy).toBe(null);
    const ok = await publish(h, id, "jarvis/t-c4", TOKEN_A);
    expect(ok.status, ok.text).toBe(200);
    expectNoLeak(h, TOKEN_B);
  });

  it("repo-binding og samtidighet: to jobber med hvert sitt repo-scopede token lykkes samtidig; et token for ET ANNET repo avvises for både klone og push", async () => {
    const T1 = syntheticInstallationToken(300, 11);
    const T2 = syntheticInstallationToken(300, 12);
    const server = await gitServer({ accepted: [{ pass: T1, repo: "owner/one.git" }, { pass: T2, repo: "owner/two.git" }] });
    server.createBareRepo("owner/one.git");
    server.createBareRepo("owner/two.git");
    const h = await harness({ slugs: ["owner/one", "owner/two"], requestTokenSlugs: ["owner/one", "owner/two"], remote: remoteOf(server) });
    const make = (repo, token) => h.api({ method: "POST", path: "/v1/jobs", body: { repo, git_token: token } });
    const [a, b] = await Promise.all([make("owner/one", T1), make("owner/two", T2)]);
    expect(a.status, a.text).toBe(201);
    expect(b.status, b.text).toBe(201);
    // omvendt: token for repo to mot repo én (og motsatt) -> avvist av serveren (maks 2 samtidige jobber: slett først)
    await h.api({ method: "DELETE", path: `/v1/jobs/${b.json.job_id}` });
    const cross = await make("owner/two", T1);
    expect(cross.status).toBe(502);
    expect(cross.json.error).toBe("git_network_failed");
    // push med feil repos token
    await h.exec(a.json.job_id, commit("jarvis/t-c5"));
    const wrongPush = await publish(h, a.json.job_id, "jarvis/t-c5", T2);
    expect(wrongPush.status).toBe(502);
    expect(wrongPush.json.error).toBe("push_failed");
    const rightPush = await publish(h, a.json.job_id, "jarvis/t-c5", T1);
    expect(rightPush.status, rightPush.text).toBe(200);
    for (const t of [T1, T2]) {
      expectNoLeak(h, t);
      for (const r of [a, b, cross, wrongPush, rightPush]) expect(r.text).not.toContain(t);
    }
  });

  it("lange tokens ende-til-ende: 900 tegn (ghs_<APPID>_<JWT>) og taket 8192 går hele veien body -> env -> credential-helper -> git -> Authorization", async () => {
    for (const length of [900, MAX_TOKEN_CHARS]) {
      const token = syntheticInstallationToken(length, 3);
      expect(token).toHaveLength(length);
      const server = await gitServer({ accepted: [{ pass: token }] });
      server.createBareRepo("owner/repo.git");
      const h = await harness({ ...REQ, remote: remoteOf(server), runner: { max_body_bytes: 65536 } });
      const created = await create(h, token, { task_id: `t-c6-${length}` });
      expect(created.status, `${length}: ${created.text.slice(0, 200)}`).toBe(201);
      await h.exec(created.json.job_id, commit(`jarvis/t-c6-${length}`));
      const pub = await publish(h, created.json.job_id, `jarvis/t-c6-${length}`, token);
      expect(pub.status, `${length}: ${pub.text.slice(0, 200)}`).toBe(200);
      await wait(() => server.events.some((e) => e.op === "push"));
      expect(new Set(server.events.filter((e) => e.ev === "auth").map((e) => e.h))).toEqual(new Set([fingerprint(token)]));
      expectNoLeak(h, token);
      await h.close();
      harnesses.pop();
    }
  });

  it("verste lekkasje: serveren REFLEKTERER passordet i en git-protokollfeil og git skriver hele tokenet på stderr - ved KLONING er det redigert i svar og logg", async () => {
    const server = await gitServer({ accepted: [{ pass: TOKEN_A }], reflect: "fetch" });
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...REQ, remote: remoteOf(server) });
    const baseline = h.registry.size;
    const r = await create(h, TOKEN_A);
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("git_network_failed");
    expect(r.json.detail).toContain("[REDACTED]");
    expect(r.json.detail).not.toContain(TOKEN_A.slice(0, 20));
    expect(r.text).not.toContain(TOKEN_A.slice(0, 20));
    await expectNoSideEffects(h);
    expectNoLeak(h, TOKEN_A);
    expectNoLeak(h, TOKEN_A.slice(0, 40)); // heller ikke en lang del av det
    expect(h.registry.size).toBe(baseline);
  });

  it("verste lekkasje ved PUBLISH: push-protokollfeilen reflekterer tokenet - 502 push_failed med redigert detalj, ingenting i logg/svar/filsystem", async () => {
    const server = await gitServer({ accepted: [{ pass: TOKEN_A }, { pass: TOKEN_B }], reflect: "push" });
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...REQ, remote: remoteOf(server) });
    const created = await create(h, TOKEN_A);
    expect(created.status, created.text).toBe(201);
    await h.exec(created.json.job_id, commit("jarvis/t-c8"));
    const r = await publish(h, created.json.job_id, "jarvis/t-c8", TOKEN_B);
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("push_failed");
    expect(r.json.detail).toContain("[REDACTED]");
    expect(r.text).not.toContain(TOKEN_B.slice(0, 20));
    expectNoLeak(h, TOKEN_A);
    expectNoLeak(h, TOKEN_B);
    expectNoLeak(h, TOKEN_B.slice(0, 40));
  });
});

describe("D: hemmelighetsregisteret (tellende, kortlevd) - kortlevde tokens hoper seg ikke opp, og én jobb kan ikke ta bort dekningen for en annen", () => {
  it("SecretRegistry: telling, hold() er idempotent, size teller ulike verdier, korte verdier ignoreres", () => {
    const reg = new SecretRegistry();
    reg.add("hemmelig-verdi-1");
    reg.add("hemmelig-verdi-1");
    expect(reg.size).toBe(1);
    reg.remove("hemmelig-verdi-1");
    expect(reg.redact("x hemmelig-verdi-1 y")).toBe("x [REDACTED] y"); // fortsatt én eier igjen
    reg.remove("hemmelig-verdi-1");
    expect(reg.redact("x hemmelig-verdi-1 y")).toBe("x hemmelig-verdi-1 y");
    expect(reg.size).toBe(0);
    reg.remove("finnes-ikke-i-registeret"); // ingen feil, ingen negativ telling
    reg.add("kort"); reg.add(undefined); reg.add(12345678); reg.add(null);
    expect(reg.size).toBe(0);
    const release = reg.hold("kortlevd-token-123");
    const release2 = reg.hold("kortlevd-token-123");
    expect(reg.size).toBe(1);
    release(); release(); release(); // flere kall teller ikke ned mer enn én gang
    expect(reg.redact("kortlevd-token-123")).toBe("[REDACTED]"); // release2 holder fortsatt
    release2();
    expect(reg.size).toBe(0);
  });

  it("en verdi som er en delstreng av en annen etterlater aldri halen av den lengste (lengst først)", () => {
    const reg = new SecretRegistry();
    reg.add("ghs_kortversjon");
    reg.add("ghs_kortversjon-med-hale-1234567890");
    expect(reg.redact("a ghs_kortversjon-med-hale-1234567890 b")).toBe("a [REDACTED] b");
    expect(reg.redact("a ghs_kortversjon b")).toBe("a [REDACTED] b");
  });

  it("sluttet jobb A tar ikke bort dekningen for jobb B som har SAMME env-hemmelighet (tidligere: Set-semantikk fjernet verdien for begge)", async () => {
    const h = await harness();
    const key = "sk-ant-api03-felles-nokkel-0123456789";
    const a = await h.createJob({ env: { ANTHROPIC_API_KEY: key } });
    const b = await h.createJob({ env: { ANTHROPIC_API_KEY: key } });
    await h.api({ method: "DELETE", path: `/v1/jobs/${a.job_id}` });
    const out = await h.exec(b.job_id, ["sh", "-c", 'echo "nøkkel=$ANTHROPIC_API_KEY"']);
    expect(out.status).toBe(200);
    expect(out.json.stdout).toBe("nøkkel=[REDACTED]\n");
    expect(h.registry.redact(`x ${key} y`)).toBe("x [REDACTED] y");
    await h.api({ method: "DELETE", path: `/v1/jobs/${b.job_id}` });
    expect(h.registry.redact(`x ${key} y`)).toBe(`x ${key} y`); // først når begge er borte
  });

  it("20 jobber med hvert sitt token (opprett + publish + slett) etterlater INGENTING i registeret, og ingen token i loggen", async () => {
    const h = await harness({ ...REQ, runner: { max_concurrent_jobs: 4 } });
    const baseline = h.registry.size;
    const tokens = [];
    for (let i = 0; i < 20; i += 1) {
      const t = syntheticInstallationToken(300, 100 + i);
      tokens.push(t);
      const created = await create(h, t);
      expect(created.status, created.text).toBe(201);
      await h.exec(created.json.job_id, commit(`jarvis/t-d${i}`));
      const pub = await publish(h, created.json.job_id, `jarvis/t-d${i}`, syntheticInstallationToken(300, 200 + i));
      expect(pub.status, pub.text).toBe(200);
      tokens.push(syntheticInstallationToken(300, 200 + i));
      await h.api({ method: "DELETE", path: `/v1/jobs/${created.json.job_id}` });
    }
    expect(h.registry.size).toBe(baseline);
    const log = h.logLines.join("\n");
    for (const t of tokens) expect(log).not.toContain(t);
  }, 120_000);

  it("samme token i to samtidige forespørsler: dekningen består til BEGGE er ferdige", async () => {
    const h = await harness({ ...REQ, runner: { max_concurrent_jobs: 4 } });
    const baseline = h.registry.size;
    const [a, b] = await Promise.all([create(h, TOKEN_A), create(h, TOKEN_A)]);
    expect(a.status, a.text).toBe(201);
    expect(b.status, b.text).toBe(201);
    expect(h.registry.size).toBe(baseline);
    const jobs = [a.json.job_id, b.json.job_id];
    await h.exec(jobs[0], commit("jarvis/t-d4a"));
    await h.exec(jobs[1], commit("jarvis/t-d4b"));
    const [pa, pb] = await Promise.all([publish(h, jobs[0], "jarvis/t-d4a", TOKEN_A), publish(h, jobs[1], "jarvis/t-d4b", TOKEN_A)]);
    expect(pa.status, pa.text).toBe(200);
    expect(pb.status, pb.text).toBe(200);
    expect(h.registry.size).toBe(baseline);
    expectNoLeak(h, TOKEN_A);
  });
});
