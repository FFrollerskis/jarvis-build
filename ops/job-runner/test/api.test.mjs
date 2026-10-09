import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNNER_TOKEN, apiRequest, createHarness } from "./support/harness.mjs";

/**
 * WP-C1: API-protokollen er smal og streng. Adversarielle tester: autentisering FØR ruting, ukjente felt, sti-/id-injeksjon,
 * flagg-injeksjon via repo/branch/argv/env, body-grenser, ugyldig JSON, prototype-forurensning.
 */

let h;
beforeAll(async () => { h = await createHarness({ runner: { max_concurrent_jobs: 8 } }); });
afterAll(async () => { await h?.close(); });

const raw = (text) => new Promise((resolve, reject) => {
  const socket = net.connect(h.socketPath);
  let out = "";
  socket.on("data", (d) => { out += d.toString("utf8"); });
  socket.on("end", () => resolve(out));
  socket.on("close", () => resolve(out));
  socket.on("error", reject);
  socket.write(text);
});
const create = (body) => h.api({ method: "POST", path: "/v1/jobs", body });

describe("A: autentisering (bearer, konstant-tid) skjer FØR ruting og kroppslesing", () => {
  it("ingen/feil/feilformet token gir 401 på ALLE ruter - også ukjente (ingen rute-orakel)", async () => {
    const paths = [["GET", "/v1/health"], ["POST", "/v1/jobs"], ["POST", "/v1/jobs/123e4567-e89b-42d3-a456-426614174000/exec"], ["DELETE", "/v1/jobs/123e4567-e89b-42d3-a456-426614174000"], ["GET", "/ukjent"], ["GET", "/v1/../etc/passwd"], ["PUT", "/v1/jobs"]];
    for (const [method, path] of paths) {
      for (const token of [null, "", "feil-token-feil-token-feil-token-feil-token", RUNNER_TOKEN.slice(0, -1), `${RUNNER_TOKEN}x`, "a".repeat(300)]) {
        const r = await apiRequest(h.socketPath, { method, path, token, body: method === "POST" ? {} : undefined });
        expect(r.status, `${method} ${path} token=${String(token).slice(0, 8)}`).toBe(401);
        expect(r.json).toEqual({ error: "unauthorized" });
        expect(r.headers["www-authenticate"]).toBe("Bearer");
      }
    }
  });

  it("andre autentiseringsskjema og dobbel/ugyldig Authorization-header avvises", async () => {
    for (const authorization of [`Basic ${Buffer.from(`x:${RUNNER_TOKEN}`).toString("base64")}`, `bearer ${RUNNER_TOKEN}`, `Bearer  ${RUNNER_TOKEN}`, `Bearer ${RUNNER_TOKEN} extra`, RUNNER_TOKEN, `Token ${RUNNER_TOKEN}`]) {
      const r = await apiRequest(h.socketPath, { path: "/v1/health", token: null, headers: { authorization } });
      expect(r.status, authorization.slice(0, 20)).toBe(401);
    }
    const dup = await raw(`GET /v1/health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${RUNNER_TOKEN}\r\nAuthorization: Bearer nope-nope-nope-nope-nope-nope-nope\r\nConnection: close\r\n\r\n`);
    expect(dup).toContain(" 401 ");
  });

  it("uautentisert forespørsel med enorm body leses ikke (401 før kroppen)", async () => {
    const r = await apiRequest(h.socketPath, { method: "POST", path: "/v1/jobs", token: null, rawBody: "x".repeat(5_000_000), headers: { "content-type": "application/json" } }).catch((e) => ({ status: 0, error: e }));
    expect([0, 401]).toContain(r.status);
  });

  it("riktig token gir 200 på /v1/health uten hemmelig info", async () => {
    const r = await h.api({ path: "/v1/health" });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["active_jobs", "api_version", "max_jobs", "status"]);
    expect(r.text).not.toContain(RUNNER_TOKEN);
  });
});

describe("B: sti og metode", () => {
  it("ukjent rute 404, feil metode 405, ugyldige stier 400", async () => {
    expect((await h.api({ path: "/v2/health" })).status).toBe(404);
    expect((await h.api({ path: "/v1/nope" })).status).toBe(404);
    expect((await h.api({ method: "POST", path: "/v1/health", body: {} })).status).toBe(405);
    expect((await h.api({ method: "GET", path: "/v1/jobs" })).status).toBe(405);
    expect((await h.api({ method: "PUT", path: "/v1/jobs", body: {} })).status).toBe(405);
    expect((await h.api({ method: "PATCH", path: "/v1/jobs/123e4567-e89b-42d3-a456-426614174000" })).status).toBe(405);
    for (const path of ["/v1/health?x=1", "/v1/jobs/..%2f..", "/v1//jobs", "/v1/jobs/../health", "/v1/health#a", "/v1/jobs\\x", "/%2e%2e/v1/health"]) {
      expect((await h.api({ path })).status, path).toBe(400);
    }
  });

  it("absolutt URI i forespørselslinjen (proxy-form) og ikke-/-start avvises", async () => {
    const abs = await raw(`GET http://example.com/v1/health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${RUNNER_TOKEN}\r\nConnection: close\r\n\r\n`);
    expect(abs).toContain(" 400 ");
    const star = await raw(`OPTIONS * HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${RUNNER_TOKEN}\r\nConnection: close\r\n\r\n`);
    expect(star).toMatch(/ (400|405) /);
  });

  it("jobb-id må være en server-utstedt UUID v4: ingen sti, ingen traversering", async () => {
    for (const id of ["../../etc/passwd", "..", ".", "abc", "123E4567-E89B-42D3-A456-426614174000", "123e4567-e89b-12d3-a456-426614174000", "123e4567e89b42d3a456426614174000", "123e4567-e89b-42d3-a456-42661417400g", "%2e%2e", "123e4567-e89b-42d3-a456-426614174000/../x"]) {
      const r = await h.api({ method: "DELETE", path: `/v1/jobs/${id}` });
      expect([400, 404], id).toContain(r.status);
      expect(r.status === 200).toBe(false);
    }
  });

  it("ukjent (men korrekt formet) jobb: exec/publish 404, DELETE er idempotent 200", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect((await h.exec(id, ["true"])).status).toBe(404);
    expect((await h.api({ method: "POST", path: `/v1/jobs/${id}/publish`, body: { branch: "jarvis/x" } })).status).toBe(404);
    const del = await h.api({ method: "DELETE", path: `/v1/jobs/${id}` });
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ deleted: false, state: "gone" });
  });
});

describe("C: body-grenser og JSON", () => {
  it("krever application/json; avviser ugyldig JSON, tom body, array, primitive og for stor body", async () => {
    expect((await create(undefined)).status).toBe(415); // ingen body/ingen content-type
    expect((await h.api({ method: "POST", path: "/v1/jobs", rawBody: "{}", headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await h.api({ method: "POST", path: "/v1/jobs", rawBody: "{ikke json", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await h.api({ method: "POST", path: "/v1/jobs", rawBody: "", headers: { "content-type": "application/json" } })).status).toBe(400);
    for (const body of ["[]", "123", '"str"', "null", "true"]) {
      const r = await h.api({ method: "POST", path: "/v1/jobs", rawBody: body, headers: { "content-type": "application/json" } });
      expect(r.status, body).toBe(400);
    }
    const big = await h.api({ method: "POST", path: "/v1/jobs", rawBody: JSON.stringify({ repo: "owner/repo", env: { A: "x".repeat(300_000) } }), headers: { "content-type": "application/json" } });
    expect(big.status).toBe(413);
  });

  it("chunked body uten content-length stoppes også ved grensen", async () => {
    const chunk = "x".repeat(65_536);
    const text = await raw(`POST /v1/jobs HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${RUNNER_TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${Array.from({ length: 6 }, () => `${chunk.length.toString(16)}\r\n${chunk}\r\n`).join("")}0\r\n\r\n`).catch((e) => `error:${e.code}`);
    expect(text).toMatch(/ 413 |error:|^$/);
  });

  it("DELETE og GET tar ikke imot body", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect((await h.api({ method: "DELETE", path: `/v1/jobs/${id}`, rawBody: "{}" })).status).toBe(400);
    expect((await h.api({ method: "GET", path: "/v1/health", rawBody: "{}" })).status).toBe(400);
  });
});

describe("D: POST /v1/jobs - strenge skjema", () => {
  it("ukjente felt avvises - API-et tar ALDRI imot docker-flagg, mounts, image, nettverk, sti eller bruker", async () => {
    for (const field of ["image", "network", "mounts", "mount", "volumes", "privileged", "user", "cwd", "path", "workdir", "dir", "docker_args", "args", "cmd", "command", "entrypoint", "cap_add", "devices", "memory", "cpus", "pids_limit", "proxy", "git_url", "url", "token", "credential", "remote", "container", "name", "labels", "__proto__", "constructor", "prototype"]) {
      const body = JSON.parse(`{"repo":"owner/repo","${field}":"x"}`);
      const r = await create(body);
      expect(r.status, field).toBe(400);
      expect(r.json.error, field).toBe("unknown_field");
    }
    expect(h.fake.containers.size).toBe(0);
  });

  it("repo: kun allowlistet owner/repo (små/store bokstaver likestilles); alt annet avvises før noe kjøres", async () => {
    expect((await create({ repo: "owner/other" })).status).toBe(403);
    expect((await create({ repo: "other/repo" })).status).toBe(403);
    expect((await create({ repo: "owner/repo.git" })).status).toBe(403);
    for (const repo of ["", "owner", "owner/", "/repo", "owner/repo/extra", "owner/..", "owner/.", "../x", "-x/y", "--upload-pack=/bin/sh/x", "owner/repo\n", "owner/repo ", "https://github.com/owner/repo", "git@github.com:owner/repo", "file:///etc", "owner/repo?x=1", "owner\\repo", "ow ner/repo", 1, null, ["owner/repo"], {}]) {
      const r = await create({ repo });
      expect([400, 403], JSON.stringify(repo)).toContain(r.status);
    }
    expect(h.fake.containers.size).toBe(0);
    expect(h.fake.calls.some((c) => c.args[0] === "create")).toBe(false);
  });

  it("base_branch: ingen flagg-injeksjon (--upload-pack), ingen .., ingen reflog-syntaks", async () => {
    for (const base_branch of ["--upload-pack=/bin/sh", "-x", "../x", "a..b", "a//b", "a/", "x.lock", "x@{1}", "x.", "a b", "x\n", "$(id)", "`id`", "a;b", 1, null, "x".repeat(101)]) {
      const r = await create({ repo: "owner/repo", base_branch });
      expect(r.status, JSON.stringify(base_branch)).toBe(400);
    }
  });

  it("env: forbudte navn (vault/DB/git-credential/proxy/HOME/PATH/LD_*/DOCKER_*) og ugyldige verdier avvises", async () => {
    for (const name of ["INFISICAL_ENCRYPTION_KEY", "JARVIS_DB_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD", "NEXTAUTH_SECRET", "LANGFUSE_SECRET_KEY", "JARVIS_GIT_CREDENTIAL_TOKEN", "JARVIS_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS", "SSH_AUTH_SOCK", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "HTTPS_PROXY", "http_proxy", "NO_PROXY", "HOME", "PATH", "LD_PRELOAD", "DOCKER_HOST", "A=B", "1BAD", "bad name", ""]) {
      const r = await create({ repo: "owner/repo", env: { [name]: "v" } });
      expect(r.status, name).toBe(400);
      expect(r.json.error, name).toBe("env_name_forbidden");
    }
    for (const env of [[], "x", { A: 1 }, { A: null }, { A: "x\u0000y" }, { A: "x".repeat(9000) }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${i}`, "x"]))]) {
      const r = await create({ repo: "owner/repo", env });
      expect(r.status, JSON.stringify(env).slice(0, 40)).toBe(400);
    }
    expect(h.fake.containers.size).toBe(0);
  });

  it("task_id/tenant_id: smalt tegnsett (ingen flagg-/label-injeksjon)", async () => {
    for (const task_id of ["a b", "x --privileged", "x\n", "a=b", "x".repeat(101), 5, "", "$(id)"]) {
      expect((await create({ repo: "owner/repo", task_id })).status, JSON.stringify(task_id)).toBe(400);
    }
    expect((await create({ repo: "owner/repo", tenant_id: "a b" })).status).toBe(400);
  });

  it("manglende repo", async () => {
    expect((await create({})).status).toBe(400);
    expect((await create({ env: {} })).status).toBe(400);
  });
});

describe("E: POST /exec - argv uten shell, ingen flagg", () => {
  let id;
  beforeAll(async () => { id = (await h.createJob()).job_id; });

  it("ukjente felt (image/mount/network/user/cwd/privileged/shell) avvises", async () => {
    for (const field of ["image", "network", "mount", "user", "cwd", "privileged", "shell", "workdir", "stdin", "container", "docker_args", "command"]) {
      const r = await h.api({ method: "POST", path: `/v1/jobs/${id}/exec`, body: JSON.parse(`{"argv":["true"],"${field}":"x"}`) });
      expect(r.status, field).toBe(400);
      expect(r.json.error, field).toBe("unknown_field");
    }
  });

  it("argv: 1..64 strenger; argv[0] uten ledende «-», uten NUL; størrelsesgrenser", async () => {
    const bad = [undefined, null, "git status", [], [""], [1], [null], [["git"]], ["-v"], ["--rm"], ["git\u0000"], ["git", "a\u0000b"], ["x".repeat(300)], Array(65).fill("a"), ["git", "x".repeat(9000)], ["a", ...Array(20).fill("x".repeat(8000))]];
    for (const argv of bad) {
      const r = await h.api({ method: "POST", path: `/v1/jobs/${id}/exec`, body: argv === undefined ? {} : { argv } });
      expect(r.status, JSON.stringify(argv)?.slice(0, 50)).toBe(400);
    }
  });

  it("timeout_ms: heltall mellom 1000 og policy-maks; env følger samme regler som ved opprettelse", async () => {
    for (const timeout_ms of [0, 999, -1, 1.5, "1000", null, 900_001, 10 ** 12]) {
      expect((await h.exec(id, ["true"], { timeout_ms })).status, String(timeout_ms)).toBe(400);
    }
    expect((await h.exec(id, ["true"], { env: { GITHUB_TOKEN: "x" } })).status).toBe(400);
    expect((await h.exec(id, ["true"], { env: { HTTPS_PROXY: "http://evil:1" } })).status).toBe(400);
    expect((await h.exec(id, ["true"], { env: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`V${i}`, "x"])) })).status).toBe(400);
  });

  it("argument som ligner shell-metategn/docker-flagg sendes som ÉN argv-verdi (aldri tolket)", async () => {
    const r = await h.exec(id, ["echo", "--privileged", "$(id)", "`id`", ";rm -rf /", "|", "&&", ">x", "--rm", "-v", "/:/host"]);
    expect(r.status).toBe(200);
    expect(r.json.stdout.trim()).toBe("--privileged $(id) `id` ;rm -rf / | && >x --rm -v /:/host");
    // docker-argv: kommandoen står ETTER containernavnet, og vi la ingen ekstra flagg foran
    const call = h.fake.calls.filter((c) => c.args[0] === "exec").at(-1);
    const nameIdx = call.args.findIndex((a) => a.startsWith("jarvis-job-"));
    expect(call.args.slice(0, nameIdx)).toEqual(["exec", "--workdir", "/work"]);
    expect(call.args.slice(nameIdx + 1)).toEqual(["echo", "--privileged", "$(id)", "`id`", ";rm -rf /", "|", "&&", ">x", "--rm", "-v", "/:/host"]);
  });
});

describe("F: POST /publish - kun jobb-branch (policy-prefiks), aldri beskyttede brancher", () => {
  let id;
  beforeAll(async () => { id = (await h.createJob()).job_id; });
  it("avviser main/master/production, flagg, traversering, ekstra segmenter, kontrolltegn", async () => {
    for (const branch of ["main", "master", "production", "refs/heads/main", "refs/heads/jarvis/x", "jarvis", "jarvis/", "jarvis/..", "jarvis/../main", "jarvis/a/b", "jarvis/-x", "jarvis/--force", "jarvis/x.lock", "jarvis/x.", "jarvis/x y", "jarvis/x\n", "jarvis/x;rm", "jarvis/$(id)", "JARVIS/x", "jarvis/æøå", "jarvis/" + "x".repeat(101), "", "+jarvis/x", ":jarvis/x", "jarvis/x:main", "HEAD", 1, null, ["jarvis/x"]]) {
      const r = await h.api({ method: "POST", path: `/v1/jobs/${id}/publish`, body: { branch } });
      expect(r.status, JSON.stringify(branch)).toBe(400);
    }
  });
  it("ukjente felt avvises (ingen force/delete/base/remote)", async () => {
    for (const field of ["force", "delete", "base", "remote", "url", "refspec", "repo", "sha", "token"]) {
      const r = await h.api({ method: "POST", path: `/v1/jobs/${id}/publish`, body: JSON.parse(`{"branch":"jarvis/x","${field}":"x"}`) });
      expect(r.status, field).toBe(400);
      expect(r.json.error, field).toBe("unknown_field");
    }
  });
});

describe("G: feilsvar lekker ikke interne detaljer", () => {
  it("feilsvar er kun {error, detail?} med korte stabile koder", async () => {
    const r = await create({ repo: "owner/other" });
    expect(Object.keys(r.json)).toEqual(["error"]);
    expect(r.text).not.toMatch(/\/tmp|\/var|node_modules|at .*\.mjs/);
  });
});
