import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EgressProxy, parseConnectTarget } from "../egress-proxy.mjs";
import { DockerClient } from "../lib/docker.mjs";
import { RunnerError } from "../lib/errors.mjs";
import { assertPathAllowed, assertPathAllowedCompiled, compileDenyPaths } from "../lib/git.mjs";
import { scrubPaths, SecretRegistry } from "../lib/log.mjs";
import { createGitSpy } from "./support/git-spy.mjs";
import { createHarness, gitSync, RUNNER_TOKEN, syntheticInstallationToken } from "./support/harness.mjs";
import { makeTempDir } from "./support/tmp.mjs";

/**
 * WP-C1: DEN STORE ADVERSARIELLE TESTEN. Alt her er en angriper som prøver å komme seg ut av, eller forbi, runnerens grenser - mot den EKTE tjenesten (HTTP over Unix-socket, ekte
 * `git`, ekte filsystem; kun `docker` er en testdobler). Hver gruppe viser at angrepet FEILER LUKKET: riktig stabil feilkode, og INGEN bivirkning (ingen docker create/start/exec/rm,
 * ingen jobbkatalog, ingen jobbplass brukt, ingen git-kall). Det som er dekket grundig i en spesialisert fil (egress-proxy, credential-helper, bundle-forfalskninger) er bare
 * referert; her ligger angrepene på tvers: protokoll, skjema, policy, samtidighet, filsystem, hemmeligheter, rutenett og kildekodevakter.
 *
 * Produksjonsstandarden for jobb-env (`env_allow` = kun ANTHROPIC_API_KEY) brukes her - ikke harnessens utvidede testliste.
 */

const PROD_ENV_ALLOW = ["ANTHROPIC_API_KEY"];

/** @type {Array<{ close(): Promise<void> }>} */
let open = [];
afterEach(async () => {
  for (const h of open) await h.close().catch(() => undefined);
  open = [];
});

/** @param {Parameters<typeof createHarness>[0]} [options] */
async function harness(options = {}) {
  const h = await createHarness({ ...options, runner: { env_allow: PROD_ENV_ALLOW, ...(options.runner ?? {}) } });
  open.push(h);
  return h;
}

/** Docker-kall som ville ha endret verden (alt utenom lesing). */
const MUTATING = new Set(["create", "start", "exec", "rm"]);
const mutations = (h, from = 0) => h.fake.calls.slice(from).filter((c) => MUTATING.has(c.args[0] ?? "")).map((c) => c.args[0]);
/** Stillbilde av «verden» før et angrep: antall docker-kall, jobbkataloger og aktive jobber. */
async function snapshot(h) {
  return { calls: h.fake.calls.length, dirs: (await readdir(h.baseDir)).sort(), active: h.service.manager.activeJobs, containers: [...h.fake.containers.keys()].sort() };
}
/** Asserter at INGENTING ble endret siden `before`. */
async function expectNoSideEffects(h, before, label = "") {
  const now = await snapshot(h);
  expect(mutations(h, before.calls), `docker-kall: ${label}`).toEqual([]);
  expect(now.dirs, `kataloger: ${label}`).toEqual(before.dirs);
  expect(now.active, `jobber: ${label}`).toBe(before.active);
  expect(now.containers, `containere: ${label}`).toEqual(before.containers);
}

/**
 * Rå HTTP over Unix-socket (ingen klientbibliotek som «retter» noe). Returnerer all tekst serveren sendte og statuskodene i rekkefølge.
 * @param {string} socketPath @param {string | Buffer} data @param {{ idleMs?: number, end?: boolean }} [options]
 */
function raw(socketPath, data, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const chunks = [];
    let timer;
    const finish = () => { clearTimeout(timer); socket.destroy(); const text = Buffer.concat(chunks).toString("latin1"); resolve({ text, statuses: [...text.matchAll(/^HTTP\/1\.[01] (\d{3})/gm)].map((m) => Number(m[1])) }); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(finish, options.idleMs ?? 400); };
    socket.on("data", (d) => { chunks.push(d); arm(); });
    socket.on("close", finish);
    socket.on("error", (e) => { if (e.code === "ECONNRESET" || e.code === "EPIPE") finish(); else reject(e); });
    socket.on("connect", () => { socket.write(data); if (options.end) socket.end(); arm(); });
  });
}
const AUTH = `Authorization: Bearer ${RUNNER_TOKEN}`;
const i0 = (t) => Number(/-(\d+)-/.exec(t)?.[1] ?? 0);
const req = (method, path, { headers = [], body = "", auth = true } = {}) =>
  `${method} ${path} HTTP/1.1\r\nHost: runner\r\n${auth ? `${AUTH}\r\n` : ""}${headers.map((x) => `${x}\r\n`).join("")}${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ""}\r\n${body}`;

describe("A: råprotokoll mot socketen - HTTP-smugling, duplikater, rørledning, overstore og rare forespørsler", () => {
  it("Content-Length OG Transfer-Encoding (smuglingsmønsteret), duplisert/ulik Content-Length og NUL i header avvises av parseren - ingen jobb opprettes", async () => {
    const h = await harness();
    const before = await snapshot(h);
    const body = JSON.stringify({ repo: "owner/repo" });
    const attacks = {
      "CL+TE chunked": `POST /v1/jobs HTTP/1.1\r\nHost: r\r\n${AUTH}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`,
      "to ulike Content-Length": `POST /v1/jobs HTTP/1.1\r\nHost: r\r\n${AUTH}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nContent-Length: 2\r\n\r\n${body}`,
      "TE: xchunked": `POST /v1/jobs HTTP/1.1\r\nHost: r\r\n${AUTH}\r\nContent-Type: application/json\r\nTransfer-Encoding: xchunked\r\n\r\n${body}`,
      "NUL i header": `GET /v1/health HTTP/1.1\r\nHost: r\r\n${AUTH}\r\nX-Evil: a\u0000b\r\n\r\n`,
      "linjeskift uten CR": `GET /v1/health HTTP/1.1\nHost: r\n${AUTH}\n\n`,
      "mellomrom før kolon": `GET /v1/health HTTP/1.1\r\nHost: r\r\nAuthorization : Bearer ${RUNNER_TOKEN}\r\n\r\n`
    };
    for (const [label, text] of Object.entries(attacks)) {
      const r = await raw(h.socketPath, text);
      expect(r.statuses.every((s) => s >= 400) || r.statuses.length === 0, `${label}: ${r.text.slice(0, 80)}`).toBe(true);
    }
    await expectNoSideEffects(h, before, "smugling");
    expect((await h.api({ path: "/v1/health" })).status).toBe(200); // tjenesten lever videre
  });

  it("rørledning: to forespørsler i én skriving får ÉTT svar (Connection: close) - den andre behandles aldri", async () => {
    const h = await harness();
    const two = req("GET", "/v1/health") + req("POST", "/v1/jobs", { headers: ["Content-Type: application/json"], body: JSON.stringify({ repo: "owner/repo" }) });
    const r = await raw(h.socketPath, two);
    expect(r.statuses).toEqual([200]);
    // Node kan allerede ha lest den andre forespørselen (autentisert med riktig token) før forbindelsen ble lukket. Den kan ikke besvares: klienten er borte, så opprettelsen
    // avbrytes og ryddes. Ingen foreldreløs jobb, container eller katalog blir stående.
    for (let i = 0; i < 100 && (h.service.manager.activeJobs > 0 || h.fake.containers.size > 0); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.fake.containers.size).toBe(0);
    expect((await readdir(h.baseDir)).filter((e) => e !== ".runner")).toEqual([]);
  }, 30_000);

  it("overstore headere (> 16 KiB) gir 431/lukket forbindelse, og forespørselslinjer > 200 tegn avvises som invalid_path", async () => {
    const h = await harness();
    const big = await raw(h.socketPath, req("GET", "/v1/health", { headers: [`X-Pad: ${"a".repeat(20_000)}`] }));
    expect(big.statuses.every((s) => s === 431 || s === 400) || big.statuses.length === 0).toBe(true);
    const long = await h.api({ path: `/v1/${"a".repeat(300)}` });
    expect(long.status).toBe(400);
    expect(long.json.error).toBe("invalid_path");
    expect((await h.api({ path: "/v1/health" })).status).toBe(200);
  });

  it("metoder og målformer: ukjente/uvanlige metoder, absolutt URI, `*`, query/fragment/prosent/backslash/NUL/dobbel skråstrek gir aldri 2xx", async () => {
    const h = await harness();
    const before = await snapshot(h);
    const cases = [
      req("PUT", "/v1/jobs", { headers: ["Content-Type: application/json"], body: "{}" }), req("PATCH", "/v1/jobs/00000000-0000-4000-8000-000000000000"),
      req("OPTIONS", "/v1/jobs"), req("TRACE", "/v1/health"), req("CONNECT", "/v1/health"), req("PROPFIND", "/v1/health"), req("HEAD", "/v1/health"),
      req("GET", "http://localhost/v1/health"), req("GET", "*"), req("GET", "/v1/health?x=1"), req("GET", "/v1/health#frag"), req("GET", "/v1/%68ealth"),
      req("GET", "/v1\\health"), req("GET", "/v1//health"), req("GET", "/v1/./health"), req("GET", "/v1/jobs/../health"), req("GET", "/v1/health/"), req("GET", "/v1/health/x"),
      req("GET", "/V1/health"), req("GET", "/v1/Health"), req("GET", "/v2/health"), req("GET", "/health"), req("GET", "/"), req("DELETE", "/v1/health"), req("POST", "/v1/health")
    ];
    for (const text of cases) {
      const r = await raw(h.socketPath, text, { idleMs: 150 });
      const label = text.split("\r\n")[0];
      // HEAD /v1/health: Node svarer ikke-GET med 405 (metoden er ikke tillatt); `GET /v1/health/` normaliseres til health (200 er riktig og harmløst)
      if (label === "GET /v1/health/ HTTP/1.1") { expect(r.statuses, label).toEqual([200]); continue; }
      expect(r.statuses.length === 0 || r.statuses.every((s) => s >= 400), `${label} -> ${r.statuses}`).toBe(true);
    }
    await expectNoSideEffects(h, before, "metoder/stier");
  });

  it("Authorization: nøyaktig ÉN header med nøyaktig «Bearer <token>» - alle varianter (skjema, mellomrom, store/små bokstaver, delvis, utvidet, dobbel, tom) gir 401", async () => {
    const h = await harness();
    const T = RUNNER_TOKEN;
    const variants = [
      `bearer ${T}`, `BEARER ${T}`, `Bearer  ${T}`, `Bearer ${T}x`, `Bearer x${T}`, `Bearer ${T.slice(0, 31)}`, `Bearer ${T.slice(1)}`, `Bearer`, `Bearer `, "",
      `Basic ${Buffer.from(`x:${T}`).toString("base64")}`, `Token ${T}`, `Bearer ${T},Bearer ${T}`, `Bearer ${"A".repeat(1000)}`, `Bearer ${T.toLowerCase()}`
    ];
    for (const v of variants) {
      const r = await raw(h.socketPath, `GET /v1/health HTTP/1.1\r\nHost: r\r\nAuthorization: ${v}\r\n\r\n`);
      expect(r.statuses, JSON.stringify(v.slice(0, 40))).toEqual([401]);
    }
    // etterfølgende mellomrom/tab i en headerverdi er ikke en del av verdien (HTTP-parseren fjerner dem): det er SAMME header, ikke en svakhet
    for (const v of [`Bearer ${T} `, `Bearer ${T}\t`, `Bearer ${T}  `]) {
      expect((await raw(h.socketPath, `GET /v1/health HTTP/1.1\r\nHost: r\r\nAuthorization: ${v}\r\n\r\n`)).statuses, JSON.stringify(v.slice(-4))).toEqual([200]);
    }
    const dup = await raw(h.socketPath, `GET /v1/health HTTP/1.1\r\nHost: r\r\n${AUTH}\r\n${AUTH}\r\n\r\n`);
    expect(dup.statuses).toEqual([401]); // tvetydig autentisering er avvist selv om begge er riktige
    const none = await raw(h.socketPath, "GET /v1/health HTTP/1.1\r\nHost: r\r\n\r\n");
    expect(none.statuses).toEqual([401]);
    // riktig token med annen skrivemåte på HEADER-navnet er vanlig HTTP og skal virke
    const ok = await raw(h.socketPath, `GET /v1/health HTTP/1.1\r\nHost: r\r\nAUTHORIZATION: Bearer ${T}\r\n\r\n`);
    expect(ok.statuses).toEqual([200]);
  });

  it("150 samtidige uautentiserte forespørsler med tilfeldige tokens: alle 401, ingen tilstand, og de presenterte tokenene når aldri loggen", async () => {
    const h = await harness();
    const before = await snapshot(h);
    const wrong = Array.from({ length: 150 }, (_, i) => `wrong-token-${i}-${"x".repeat(30)}-${i * 7919}`);
    const results = await Promise.all(wrong.map((t) => h.api({ token: t, method: i0(t) % 2 === 0 ? "GET" : "POST", path: i0(t) % 2 === 0 ? "/v1/health" : "/v1/jobs", body: { repo: "owner/repo" } })));
    expect(results.every((r) => r.status === 401)).toBe(true);
    await expectNoSideEffects(h, before, "uautentisert flom");
    const log = h.logLines.join("\n");
    for (const t of wrong) expect(log).not.toContain(t);
    expect((await h.api({ path: "/v1/health" })).json.active_jobs).toBe(0);
  });

  it("JSON-angrep: dyp nesting, BOM, ugyldig UTF-8, enslig surrogat, __proto__/constructor på alle nivåer, dupliserte nøkler, ikke-objekter", async () => {
    const h = await harness();
    const before = await snapshot(h);
    /** `body` er en latin1-streng: hvert tegn er ÉN byte (så ugyldig UTF-8 og BOM kan sendes ordrett). */
    const send = (body) => {
      const bytes = Buffer.from(body, "latin1");
      return raw(h.socketPath, Buffer.concat([Buffer.from(`POST /v1/jobs HTTP/1.1\r\nHost: r\r\n${AUTH}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\n\r\n`, "latin1"), bytes]));
    };
    const status = async (body) => (await send(body)).statuses[0];
    const slowStatus = async (body) => {
      const bytes = Buffer.from(body, "latin1");
      return (await raw(h.socketPath, Buffer.concat([Buffer.from(`POST /v1/jobs HTTP/1.1\r\nHost: r\r\n${AUTH}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\n\r\n`, "latin1"), bytes]), { idleMs: 10_000 })).statuses[0];
    };
    // ikke-objekter og søppel
    for (const body of ["null", "[]", '"x"', "1", "true", "[[[[]]]]", "{", "}", '{"repo":"owner/repo"', '{"repo":"owner/repo"}garbage', "\xef\xbb\xbf" + '{"repo":"owner/repo"}']) {
      expect(await status(body), JSON.stringify(body.slice(0, 20))).toBe(400);
    }
    // dyp nesting (200 000 nivåer): 400, ikke en krasj
    expect(await status("[".repeat(100_000) + "]".repeat(100_000))).toBe(400);
    expect(await status('{"repo":"owner/repo","env":' + "[".repeat(100_000) + "]".repeat(100_000) + "}")).toBe(400);
    // ugyldig UTF-8 (rå 0xFF) og enslig surrogat som escape i et felt som valideres med regex
    expect(await status('{"repo":"owner/repo","task_id":"\xff\xfe"}')).toBe(400);
    expect(await status('{"repo":"owner/repo","task_id":"\\ud800"}')).toBe(400);
    expect(await status('{"repo":"owner/repo","task_id":"a\\u0000b"}')).toBe(400);
    // prototypeforurensning: alle disse er ukjente felt / forbudte env-navn, uansett nivå
    for (const body of [
      '{"repo":"owner/repo","__proto__":{"env":{"PATH":"/evil"}}}', '{"repo":"owner/repo","constructor":{"prototype":{"x":1}}}', '{"repo":"owner/repo","prototype":{}}',
      '{"repo":"owner/repo","env":{"__proto__":"x"}}', '{"repo":"owner/repo","env":{"constructor":"x"}}', '{"repo":"owner/repo","env":{"toString":"x"}}', '{"__proto__":{"repo":"owner/repo"}}'
    ]) expect(await status(body), body).toBe(400);
    // dupliserte nøkler: JSON.parse tar den siste; kun den som gjelder valideres og brukes
    expect(await status('{"repo":"owner/repo","repo":"evil/repo"}')).toBe(403);
    await expectNoSideEffects(h, before, "JSON-angrep");
    expect(await slowStatus('{"repo":"evil/repo","repo":"owner/repo"}')).toBe(201);
    expect(mutations(h, before.calls)).toEqual(["create", "start"]);
  });

  it("Content-Type: kun application/json (med valgfri utf-8-charset) leses; alt annet gir 415 FØR kroppen parses", async () => {
    const h = await harness();
    const before = await snapshot(h);
    const body = JSON.stringify({ repo: "owner/repo" });
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", "application/json; charset=utf-16", "application/json; charset=latin1", "text/json", ""]) {
      const r = await raw(h.socketPath, req("POST", "/v1/jobs", { headers: ct === "" ? [] : [`Content-Type: ${ct}`], body }));
      expect(r.statuses, ct).toEqual([415]);
    }
    await expectNoSideEffects(h, before, "content-type");
    for (const ct of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON", "application/json;charset=UTF-8"]) {
      const r = await raw(h.socketPath, req("POST", "/v1/jobs", { headers: [`Content-Type: ${ct}`], body }), { idleMs: 10_000 });
      expect(r.statuses, ct).toEqual([201]);
      const id = /"job_id":"([0-9a-f-]{36})"/.exec(r.text)?.[1];
      await h.api({ method: "DELETE", path: `/v1/jobs/${id}` });
    }
  });
});

describe("B: skjema - injeksjon i HVERT felt avvises før noe reserveres, opprettes eller kjøres", () => {
  /** @param {Awaited<ReturnType<typeof harness>>} h @param {string} label @param {(value: any) => Promise<{ status: number, json?: any }>} send @param {any[]} values @param {number[]} statuses */
  async function rejectAll(h, label, send, values, statuses) {
    const before = await snapshot(h);
    for (const value of values) {
      const r = await send(value);
      expect(statuses, `${label}: ${JSON.stringify(value)?.slice(0, 60)} -> ${r.status} ${JSON.stringify(r.json)}`).toContain(r.status);
    }
    await expectNoSideEffects(h, before, label);
  }

  it("repo: stitraversering, URL-former, flagg, unicode-lookalikes, kontrolltegn, feil typer - aldri 201", async () => {
    const h = await harness();
    const send = (repo) => h.api({ method: "POST", path: "/v1/jobs", body: { repo } });
    await rejectAll(h, "repo", send, [
      "../etc/passwd", "owner/../repo", "owner/repo/../../x", "owner/repo/..", "owner/..", "owner/.", "./owner/repo", "/owner/repo", "owner//repo", "owner/repo/", "owner/repo/extra",
      "https://github.com/owner/repo", "https://github.com/owner/repo.git", "git@github.com:owner/repo.git", "file:///etc/passwd", "ssh://git@github.com/owner/repo", "github.com/owner/repo",
      "owner/repo.git", "owner/repo.", "owner/repo ", " owner/repo", "owner/repo\n", "owner/repo\u0000", "owner/re\npo", "owner\\repo", "owner%2frepo", "owner:repo", "owner@repo",
      "--upload-pack=touch /tmp/pwn/x", "-x/y", "owner/-repo", "-owner/repo", "ow ner/repo", "ownеr/repo" /* kyrillisk е */, "ｏｗｎｅｒ/repo" /* fullbredde */, "owner/repo".toUpperCase().replace("OWNER", "0WNER"),
      "a".repeat(200) + "/repo", "owner/" + "r".repeat(200), "", "/", "x", null, 0, 1, true, [], ["owner/repo"], { slug: "owner/repo" }
    ], [400, 403]);
    // og skrivemåter av det TILLATTE repoet som lowercases er greie (GitHub skiller ikke på store/små bokstaver)
    const ok = await send("OWNER/Repo");
    expect(ok.status).toBe(201);
  });

  it("base_branch: flagg-injeksjon (--upload-pack, -c), reflog-/revisjonssyntaks, traversering, kontrolltegn, mellomrom - aldri git-kall", async () => {
    const h = await harness();
    const send = (base_branch) => h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo", base_branch } });
    await rejectAll(h, "base_branch", send, [
      "-x", "--upload-pack=touch /tmp/pwn/x", "-c core.fsmonitor=x", "--exec=x", "a..b", "a//b", "a/", "a.lock", "main.lock", "a@{u}", "a@{-1}", "@{-1}", "HEAD^", "HEAD~1", "main^{commit}",
      "a:b", "a b", "a\tb", "a\nb", "a\u0000b", "a\\b", "a?b", "a*b", "a[b", "a~b", "a^b", "refs/heads/../../x", "../x", "./x", "x/.", "x/..", ".hidden", "/abs", "x;rm -rf /", "$(id)", "`id`", "a|b", "a&b", "a>b",
      "é", "ab‮cd", "b".repeat(101), "", 0, true, [], {}, null
    ], [400]);
  });

  it("task_id / tenant_id: ingen label-/flagg-injeksjon (docker --label tar KEY=VALUE), smalt tegnsett og lengde", async () => {
    const h = await harness();
    for (const field of ["task_id", "tenant_id"]) {
      await rejectAll(h, field, (v) => h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo", [field]: v } }),
        ["x --privileged", "a=b", "a b", "a\nb", "a\u0000b", "$(id)", "`id`", "x;y", "x".repeat(101), "", "æøå", 1, true, [], {}, null], [400]);
    }
    // en etikett som LIGNER et flagg er bare en etikett-VERDI i ett argv-element etter --label: aldri et eget flagg
    const job = await h.createJob({ task_id: "--privileged", tenant_id: "--cap-add" });
    const create = h.fake.calls.find((c) => c.args[0] === "create" && c.args.includes("jarvis.task_id=--privileged"));
    expect(create).toBeTruthy();
    expect(create.args.indexOf("--label")).toBeGreaterThan(-1);
    expect(create.args.filter((a) => a === "--privileged" || a === "--cap-add")).toEqual([]);
    expect(job.job_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("env med PRODUKSJONENS allow-liste (kun ANTHROPIC_API_KEY): alle andre navn - også ufarlige - nektes; ugyldige verdier og typer nektes", async () => {
    const h = await harness();
    const names = [
      "PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "DOCKER_HOST", "DOCKER_CONFIG", "HTTPS_PROXY", "no_proxy", "GITHUB_TOKEN", "GH_TOKEN", "JARVIS_GIT_CREDENTIAL_TOKEN", "GIT_ASKPASS", "GIT_SSH_COMMAND",
      "GIT_CONFIG_COUNT", "GIT_DIR", "SSH_AUTH_SOCK", "GCONV_PATH", "LOCPATH", "TMPDIR", "XDG_RUNTIME_DIR", "SSL_CERT_FILE", "GODEBUG", "BASH_ENV", "NODE_OPTIONS", "LANG", "LC_ALL", "TZ", "CI",
      "anthropic_api_key", "Anthropic_Api_Key", "ANTHROPIC_API_KEY ", " ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY=x", "ANTHROPIC_API_KEY\n", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
      "__proto__", "constructor", "toString", "hasOwnProperty", "", "1BAD", "A-B", "A.B", "ÆØÅ", "A".repeat(101)
    ];
    await rejectAll(h, "env-navn (create)", (name) => h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo", env: { [name]: "v" } } }), names, [400]);
    const job = await h.createJob({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-adv-0123456789" } });
    const before = await snapshot(h);
    for (const name of names) {
      const r = await h.exec(job.job_id, ["true"], { env: { [name]: "v" } });
      expect(r.status, `exec env ${name}`).toBe(400);
    }
    await expectNoSideEffects(h, before, "env-navn (exec)");
    // verdier og typer
    await rejectAll(h, "env-verdier", (value) => h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo", env: { ANTHROPIC_API_KEY: value } } }),
      ["a\u0000b", "x".repeat(8193), 1, true, null, [], {}], [400]);
    await rejectAll(h, "env-form", (env) => h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo", env } }),
      [[], "x", 1, true, null, [["ANTHROPIC_API_KEY", "x"]], Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`N${i}`, "v"]))], [400]);
    // og det eneste tillatte navnet virker, i begge kall
    expect((await h.exec(job.job_id, ["true"], { env: { ANTHROPIC_API_KEY: "sk-ant-api03-adv-0123456789" } })).status).toBe(200);
  });

  it("exec: argv-former, argv[0] med flagg/kontrolltegn, størrelser, timeout-verdier og ALLE felt som ville vært docker-flagg (ukjente felt)", async () => {
    const h = await harness();
    const job = await h.createJob();
    const send = (body) => h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/exec`, body });
    await rejectAll(h, "exec-argv", (argv) => send({ argv }), [
      "sh", "", null, 1, {}, [], [""], ["-c", "id"], ["--privileged"], ["\nsh"], ["sh\u0000"], ["s\u0007h"], ["a".repeat(257)], [1], [null], [["sh"]], [{}], ["sh", 1], ["sh", null], ["sh", "a\u0000b"],
      Array.from({ length: 65 }, () => "x"), ["sh", "a".repeat(8193)], Array.from({ length: 10 }, () => "a".repeat(8000))
    ], [400]);
    await rejectAll(h, "exec-timeout", (timeout_ms) => send({ argv: ["true"], timeout_ms }), [0, 999, -1, 1.5, 900_001, 1e9, Number.MAX_SAFE_INTEGER, "1000", null, true, [], {}], [400]);
    const flagFields = ["image", "mount", "mounts", "volume", "volumes", "network", "net", "user", "u", "privileged", "cap_add", "cap-add", "capabilities", "security_opt", "device", "devices", "pid", "ipc",
      "workdir", "cwd", "w", "tty", "t", "stdin", "i", "interactive", "detach", "d", "shell", "cmd", "command", "entrypoint", "container", "container_id", "name", "docker", "flags", "args", "options", "extra", "label", "labels",
      "memory", "cpus", "pids_limit", "restart", "env_file", "env-file", "uid", "gid", "group", "hostname", "dns", "add_host", "publish", "port", "ports", "link", "cgroup", "ulimit", "sysctl", "tmpfs", "init", "pull", "platform", "runtime", "__proto__", "constructor"];
    await rejectAll(h, "exec-ukjente-felt", (field) => send({ argv: ["true"], [field]: "x" }), flagFields, [400]);
    await rejectAll(h, "create-ukjente-felt", (field) => h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo", [field]: "x" } }), flagFields, [400]);
    await rejectAll(h, "publish-ukjente-felt", (field) => h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch: "jarvis/x", [field]: "x" } }), flagFields, [400]);
    // en helt gyldig argv med shell-metategn sendes som data
    const r = await send({ argv: ["echo", "--privileged", "$(id)", "`id`", ";", "&&", "|", ">", "/etc/passwd", "*"] });
    expect(r.status).toBe(200);
    expect(r.json.stdout).toBe("--privileged $(id) `id` ; && | > /etc/passwd *\n"); // ordrett, aldri tolket
  });

  it("publish: branch må være <prefiks><id> - main/master/production, ref-former, traversering, ekstra segmenter, kontrolltegn, ref-metategn og feil typer avvises uten å røre git", async () => {
    const h = await harness();
    const job = await h.createJob();
    await h.exec(job.job_id, ["sh", "-c", "echo x > f.txt && git checkout -q -b jarvis/t && git add -A && git commit -q -m t"]);
    const send = (branch) => h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch } });
    await rejectAll(h, "branch", send, [
      "main", "master", "production", "develop", "HEAD", "refs/heads/main", "refs/heads/jarvis/x", "heads/main", "jarvis", "jarvis/", "jarvis//x", "jarvis/../main", "jarvis/..", "jarvis/.", "jarvis/a/b", "jarvis/a/../b",
      "jarvis/-x", "jarvis/--force", "jarvis/a..b", "jarvis/x.lock", "jarvis/x.", "Jarvis/x", "JARVIS/x", "jarvis/x y", "jarvis/x\n", "jarvis/x\u0000", "jarvis/x:y", "jarvis/x~1", "jarvis/x^", "jarvis/x?", "jarvis/x*", "jarvis/x[",
      "jarvis/x\\y", "jarvis/@{-1}", "jarvis/x@{1}", "jarvis/.hidden", "jarvis/" + "b".repeat(101), "jarvis/æ", "jarvis/x;rm", "jarvis/$(id)", "+jarvis/x", ":jarvis/x", "jarvis/x:main", "jarvis/x:refs/heads/main",
      "", " jarvis/x", "jarvis/x ", null, 0, true, [], ["jarvis/x"], {}
    ], [400]);
    expect((await send("jarvis/ok-1")).status).toBe(200); // og det tillatte virker
  });

  it("jobb-id: kun serverutstedte UUID v4 - ingen stier, ingen andre UUID-versjoner, ingen store bokstaver, ingen suffiks", async () => {
    const h = await harness();
    const before = await snapshot(h);
    for (const id of ["..", ".", "%2e%2e", "../jobs", "00000000-0000-0000-0000-000000000000", "11111111-1111-1111-1111-111111111111", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaaX", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa", "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa", "jarvis-job-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "x".repeat(36)]) {
      for (const [method, tail] of [["POST", "/exec"], ["POST", "/publish"], ["DELETE", ""]]) {
        const r = await raw(h.socketPath, req(method, `/v1/jobs/${id}${tail}`, method === "POST" ? { headers: ["Content-Type: application/json"], body: "{}" } : {}), { idleMs: 100 });
        expect(r.statuses.length === 0 || r.statuses.every((s) => s === 400 || s === 404), `${method} ${id}${tail}: ${r.statuses}`).toBe(true);
      }
    }
    // et korrekt formet, ukjent id er 404 for exec/publish og idempotent 200 for DELETE
    const unknown = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect((await h.api({ method: "POST", path: `/v1/jobs/${unknown}/exec`, body: { argv: ["true"] } })).status).toBe(404);
    expect((await h.api({ method: "POST", path: `/v1/jobs/${unknown}/publish`, body: { branch: "jarvis/x" } })).status).toBe(404);
    expect((await h.api({ method: "DELETE", path: `/v1/jobs/${unknown}` })).json).toEqual({ deleted: false, state: "gone" });
    await expectNoSideEffects(h, before, "jobb-id");
  });
});

describe("I: policyen er vertsadmins - ingen konfignøkkel kan overstyres via API-et, og ruteflaten er nøyaktig de fem dokumenterte", () => {
  it("hver nøkkel i runner-/proxy-konfigen avvises som ukjent felt i create, exec og publish (policyen i minnet er uendret)", async () => {
    const h = await harness();
    const keys = ["socket_path", "socket_group", "token_file", "base_dir", "docker_bin", "docker_host", "git_bin", "image", "network", "egress_proxy_url", "user", "memory", "cpus", "pids_limit", "tmpfs_size",
      "max_concurrent_jobs", "max_job_lifetime_s", "default_exec_timeout_ms", "max_exec_timeout_ms", "max_output_bytes", "max_body_bytes", "allowed_repos", "git_credentials", "branch_prefix", "clone_depth",
      "clone_timeout_ms", "publish", "git_identity", "sweep_interval_s", "env_allow", "listen_host", "listen_port", "allow", "allowed_client_cidrs", "version", "runner", "egress_proxy", "allowFile", "skipUidCheck", "remote"];
    const policyBefore = JSON.stringify(h.config);
    const before = await snapshot(h);
    const job = await h.createJob();
    const after = await snapshot(h);
    for (const key of keys) {
      for (const [path, body] of [["/v1/jobs", { repo: "owner/repo" }], [`/v1/jobs/${job.job_id}/exec`, { argv: ["true"] }], [`/v1/jobs/${job.job_id}/publish`, { branch: "jarvis/x" }]]) {
        const r = await h.api({ method: "POST", path, body: { ...body, [key]: key === "env_allow" ? ["PATH"] : "x" } });
        expect(r.status, `${path} ${key}`).toBe(400);
        expect(r.json.error, `${path} ${key}`).toBe("unknown_field");
      }
    }
    expect(JSON.stringify(h.config)).toBe(policyBefore);
    expect(Object.isFrozen(h.config)).toBe(true);
    expect(Object.isFrozen(h.config.policy)).toBe(true);
    expect(Object.isFrozen(h.config.envAllow)).toBe(true);
    expect(mutations(h, after.calls)).toEqual([]);
    expect(before.active + 1).toBe(h.service.manager.activeJobs);
  });

  it("ruteflaten: nøyaktig GET /v1/health, POST /v1/jobs, POST /v1/jobs/:id/exec, POST /v1/jobs/:id/publish og DELETE /v1/jobs/:id - alt annet er 404/405", async () => {
    const h = await harness();
    const job = await h.createJob();
    const id = job.job_id;
    const documented = new Map([
      ["GET /v1/health", 200], ["POST /v1/jobs", 400], [`POST /v1/jobs/${id}/exec`, 400], [`POST /v1/jobs/${id}/publish`, 400], [`DELETE /v1/jobs/${id}`, 200]
    ]);
    const paths = ["/v1/health", "/v1/jobs", `/v1/jobs/${id}`, `/v1/jobs/${id}/exec`, `/v1/jobs/${id}/publish`,
      "/v1", "/v1/", "/v1/config", "/v1/policy", "/v1/images", "/v1/image", "/v1/containers", "/v1/container", "/v1/docker", "/v1/exec", "/v1/shell", "/v1/run", "/v1/networks", "/v1/volumes",
      "/v1/token", "/v1/tokens", "/v1/reload", "/v1/shutdown", "/v1/restart", "/v1/status", "/v1/metrics", "/v1/debug", "/v1/logs", "/v1/env", "/v1/credentials", "/v1/git", "/v1/repos", "/v1/sweep", "/v1/reconcile",
      `/v1/jobs/${id}/files`, `/v1/jobs/${id}/file`, `/v1/jobs/${id}/logs`, `/v1/jobs/${id}/attach`, `/v1/jobs/${id}/stop`, `/v1/jobs/${id}/kill`, `/v1/jobs/${id}/restart`, `/v1/jobs/${id}/cp`, `/v1/jobs/${id}/copy`,
      `/v1/jobs/${id}/checkout`, `/v1/jobs/${id}/push`, `/v1/jobs/${id}/bundle`, `/v1/jobs/${id}/env`, `/v1/jobs/${id}/network`, `/v1/jobs/${id}/mounts`, `/v1/jobs/${id}/exec/extra`, `/v1/jobs/${id}/publish/extra`,
      "/metrics", "/debug/pprof", "/healthz", "/health", "/status", "/.env", "/etc/passwd", "/containers/json", "/var/run/docker.sock"];
    const seen = [];
    const deferred = `DELETE /v1/jobs/${id}`; // sletter jobben: tas til slutt, så de andre rutene fortsatt ser en levende jobb
    for (const path of paths) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const key = `${method} ${path}`;
        if (key === deferred) continue;
        const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
        const r = await h.api({ method, path, ...(hasBody ? { body: {} } : {}) });
        if (documented.has(key)) {
          expect(r.status, key).toBe(documented.get(key));
          seen.push(key);
        } else {
          expect([404, 405, 400].includes(r.status), `${key} -> ${r.status} ${r.text.slice(0, 80)}`).toBe(true);
          expect(r.status === 400 ? r.json.error : "ok", key).toMatch(/^(ok|invalid_path|invalid_job_id)$/); // ingen annen rute når skjemakontroll
        }
      }
    }
    const last = await h.api({ method: "DELETE", path: `/v1/jobs/${id}` });
    expect(last.status, deferred).toBe(documented.get(deferred));
    seen.push(deferred);
    expect(seen.sort()).toEqual([...documented.keys()].sort());
  });
});

describe("C: stiregler ved publish (assertPathAllowed) - .git i alle skrivemåter, NTFS-varianter, nekteliste og aliaser", () => {
  const DENY = [".github/", ".gitmodules", ".gitattributes", ".lfsconfig"];
  /** @returns {string | null} `kode:detalj` hvis nektet, ellers null */
  const denied = (path, deny = DENY) => {
    try { assertPathAllowed(path, deny); return null; } catch (e) { return e instanceof RunnerError ? `${e.code}:${e.detail}` : `other:${e}`; }
  };
  const zw = "\u200b";

  it("harde regler uavhengig av konfig: .git (store/små bokstaver, usynlige tegn, etterfølgende punktum/mellomrom, NTFS-kortnavn, alternative datastrømmer), ., .., tomme komponenter, kontrolltegn, backslash, absolutt sti", () => {
    const hard = [
      ".git", ".GIT", ".Git", ".git/config", ".git/hooks/pre-commit", "a/.git/config", "a/b/.git", `.gi${zw}t/config`, `.g\u200dit`, `.git${zw}`, "\ufeff.git/x", ".git.", ".git..", ".git ", ".git . .", ".git./x", ".git /x",
      "GIT~1", "git~1/x", "a/GIT~1", "a/git~2/x", "git~9", ".git:$INDEX_ALLOCATION/x", ".git::$INDEX_ALLOCATION", "a/b:c", "x:y", "C:/x", "a/.git:stream/x", "\uff0egit/config" /* fullbredde punktum */,
      "", "/", "/abs", "/etc/passwd", "a//b", "a/", "./a", "a/./b", "../a", "a/../b", "a/..", ".", "..", "a\\b", "a\nb", "a\tb", "a\u0000b", "a\u007fb", "a".repeat(4097)
    ];
    for (const path of hard) expect(denied(path, []), JSON.stringify(path.slice(0, 40))).not.toBeNull();
    // ... og vanlige filer med ligner navn er IKKE nektet (ingen falske positive)
    for (const ok of ["src/a.ts", "README.md", ".gitignore", ".gitkeep", "docs/git-notes.md", "github/readme.md", ".github-notes/x", "a/gitmodules", "gitignore", "x.git/y", "git", "git~", "git~x", "legit/file", "a b/c d.txt", "ünï/çødé.txt", "a/b/c/d/e/f.txt"]) {
      expect(denied(ok), ok).toBeNull();
    }
  });

  it("standard nekteliste (.github/, .gitmodules, .gitattributes, .lfsconfig): skrivemåter, usynlige tegn, etterfølgende punktum/mellomrom OG NTFS-kortnavn (github~1, gitmod~1, gitatt~1, lfscon~1)", () => {
    for (const path of [
      ".github/workflows/ci.yml", ".github/CODEOWNERS", ".github", ".GitHub/x", ".GITHUB/Workflows/x.yml", `.gith${zw}ub/x`, ".github./workflows/x.yml", ".github /x", ".github../x", "github~1/workflows/x.yml", "GITHUB~1", "GitHub~1/x",
      ".gitmodules", ".GITMODULES", ".gitmodules.", ".gitmodules ", `.gitmod${zw}ules`, "gitmod~1", "GITMOD~1", ".gitattributes", ".GitAttributes", "gitatt~1", "GITATT~1",
      ".lfsconfig", ".LfsConfig", ".lfsconfig.", `.lfs${zw}config`, "lfscon~1", "LFSCON~1"
    ]) {
      expect(denied(path)?.startsWith("path_denied:matches_deny_list:"), JSON.stringify(path)).toBe(true);
    }
    // mapper og filer som bare LIGNER: ikke nektet
    for (const ok of [".github-actions/x", ".githubx/y", "github/x", "a.github/x", ".gitmodulesx", ".gitattributes2", "gitmodules", ".lfsconfigx", "lfsconfig", "README.md"]) expect(denied(ok), ok).toBeNull();
  });

  it("A-F1: oppføringer med ÉN komponent gjelder på ALLE nivåer (som .gitignore) - nestede .gitattributes/.gitmodules/.lfsconfig/.github omgår ikke lenger nektelisten", () => {
    for (const path of [
      "src/.gitattributes", "a/b/c/.gitattributes", "src/.GitAttributes", `src/.gitattr${zw}ibutes`, "src/.gitattributes.", "src/gitatt~1", "a/b/GITATT~1", "src/gitatt~2", "src/gi7d29~1", "src/GI7D29~3",
      "sub/.gitmodules", "a/b/.gitmodules", "a/gitmod~1", "a/gitmod~4", "a/gitmod~5", "a/gi7eba~1", "a/GI7EBA~9",
      "src/.lfsconfig", "a/b/.lfsconfig", "x/lfscon~1", "x/LFSCON~2",
      "pakke/.github/workflows/ci.yml", "a/b/.github", "a/.GitHub/x", "a/github~1/x", "a/.github./x",
      // en MAPPE med nekteliste-navnet nederst i treet
      "x/.gitattributes/y.txt", "x/.lfsconfig/z"
    ]) {
      expect(denied(path)?.startsWith("path_denied:matches_deny_list:"), JSON.stringify(path)).toBe(true);
    }
    // ... men lignende navn på hvilket som helst nivå slipper gjennom (ingen falske positive)
    for (const ok of [
      "foo.gitattributes.md", "docs/gitmodules.txt", "docs/gitattributes", "src/lfsconfig", "src/x.lfsconfig", "src/.lfsconfig.bak", "docs/.gitattributes.md", "a/.github-actions/x", "a/.githubx/y", "a/github/x",
      "src/gitatt~", "src/gitatt~x", "src/gitattr~1", "src/gitmod~", "src/gi7eb~1", "src/gitatt1", "a/b/c/d.txt"
    ]) {
      expect(denied(ok), ok).toBeNull();
    }
  });

  it("A-F1: NTFS-kortnavn gjelder hver komponent (ikke bare den første), også for oppføringer med sti", () => {
    const deny = ["config/.env", "ci/.github/"];
    for (const path of ["config/.env", "config/env~1", "config/ENV~2", "ci/.github/x", "ci/github~1/x", "CI/GITHUB~3/x"]) {
      expect(denied(path, deny)?.startsWith("path_denied:matches_deny_list:"), path).toBe(true);
    }
    for (const ok of ["config/env", "config/.envrc", "x/config/.env", "ci/x/.github/y", "ci/github/x"]) expect(denied(ok, deny), ok).toBeNull(); // forankret: bare fra roten
  });

  it("konfigurerbar nekteliste: oppføring med én komponent = alle nivåer, oppføring med sti = fra roten; ingen falske treff på søsken med felles prefiks", () => {
    const deny = ["secrets/", "terraform", ".env", "infra/prod/"];
    for (const path of [
      "secrets/k.txt", "secrets", "SECRETS/x", "terraform", "terraform/main.tf", "TERRAFORM/x", ".env", ".ENV", ".env.", "env~1", "infra/prod/db.tf", "Infra/Prod/x",
      "app/secrets/x", "a/b/terraform/main.tf", "svc/.env", "svc/env~1" // én komponent: alle nivåer (A-F1)
    ]) {
      expect(denied(path, deny)?.startsWith("path_denied:matches_deny_list:"), path).toBe(true);
    }
    for (const ok of [
      "secretsx/a", "my-secrets/a", "terraform2/main.tf", "terraformer", ".envrc", ".env-example", "infra/prod2/x", "infra/production/x",
      "app/infra/prod/x" /* sti-oppføring: forankret i roten */, "infra/x/prod/y", "a/terraform2/b"
    ]) {
      expect(denied(ok, deny), ok).toBeNull();
    }
  });

  it("A-F1: compileDenyPaths klassifiserer oppføringene (forankret = har sti) og en tom/degenerert oppføring treffer aldri noe", () => {
    const compiled = compileDenyPaths([".github/", "a/b", "x", ""]);
    expect(compiled.map((c) => [c.entry, c.anchored, c.components])).toEqual([[".github/", false, [".github"]], ["a/b", true, ["a", "b"]], ["x", false, ["x"]], ["", false, []]]);
    expect(() => assertPathAllowedCompiled("any/thing", compiled)).not.toThrow();
    expect(denied("a/b/c", ["a/b"])).toMatch(/^path_denied:matches_deny_list:a\/b$/);
  });
});

describe("D: fail-closed - ugyldig token-fil, ødelagt PAT og utilgjengelig docker gir en stabil feil og INGEN bivirkning", () => {
  /** @param {string} file */
  const tokenCases = (file) => ({
    "modus 0644": () => chmod(file, 0o644),
    "modus 0666": () => chmod(file, 0o666),
    "modus 0604 (andre kan lese)": () => chmod(file, 0o604),
    "modus 0670 (gruppen kan skrive)": () => chmod(file, 0o670),
    "tom fil": () => writeFile(file, ""),
    "for kort (31 tegn)": () => writeFile(file, `${"a".repeat(31)}\n`),
    "mellomrom midt i": () => writeFile(file, `${"a".repeat(20)} ${"b".repeat(20)}\n`),
    "linjeskift midt i": () => writeFile(file, `${"a".repeat(20)}\n${"b".repeat(20)}\n`),
    "ikke-ASCII": () => writeFile(file, `${"æ".repeat(40)}\n`),
    "for stor (17 KiB)": () => writeFile(file, `${"a".repeat(17 * 1024)}\n`)
  });

  it("bearer-token-filen: feil modus, tom, for kort, ugyldige tegn, for stor, symlenke, katalog, mangler - tjenesten starter IKKE (ingen socket, ingen docker-mutasjon)", async () => {
    const labels = Object.keys(tokenCases("/x"));
    for (const label of [...labels, "symlenke", "katalog", "mangler"]) {
      const h = await harness({ autoStart: false });
      const file = h.tokenFile;
      if (label === "symlenke") {
        const real = `${file}.real`;
        await writeFile(real, `${RUNNER_TOKEN}\n`, { mode: 0o600 });
        await rm(file);
        await symlink(real, file);
      } else if (label === "katalog") {
        await rm(file);
        await mkdir(file);
      } else if (label === "mangler") {
        await rm(file);
      } else {
        await tokenCases(file)[label]();
      }
      const error = await h.service.start().then(() => null, (e) => e);
      expect(error, label).not.toBeNull();
      expect(String(error?.code ?? error?.message), label).toMatch(/permissions_too_open|format_invalid|too_large|is_symlink|not_a_regular_file|unreadable/);
      expect(h.service.server, label).toBeUndefined();
      await expect(lstat(h.socketPath), label).rejects.toThrow(); // ingen socket
      expect(mutations(h), label).toEqual([]);
      expect(String(error?.message)).not.toContain(RUNNER_TOKEN);
    }
  }, 60_000);

  it("selve prosessene (server.mjs og egress-proxy.mjs): manglende, relativ, ikke-vanlig, symlenke, for stor, verdensskrivbar eller ikke-root-eid policy-fil gir exit 1 med en stabil kode som JSON på stderr - ingen socket, ingen lytting", async () => {
    const dir = await makeTempDir("jr-main-");
    const write = async (name, content, mode) => { const f = join(dir, name); await writeFile(f, content); await chmod(f, mode); return f; };
    const valid = JSON.stringify({ version: 1, runner: { token_file: join(dir, "t"), image: `sha256:${"a".repeat(64)}`, network: "jarvis-jobs", egress_proxy_url: "http://172.30.77.1:3128", allowed_repos: ["o/r"], git_credentials: { "o/r": { token_file: join(dir, "p") } }, socket_path: join(dir, "x.sock") }, egress_proxy: { listen_host: "127.0.0.1", listen_port: 39999, allowed_client_cidrs: ["127.0.0.0/8"] } });
    const real = await write("real.json", valid, 0o644);
    await symlink(real, join(dir, "link.json"));
    await mkdir(join(dir, "dir.json"));
    const cases = {
      "mangler": [join(dir, "finnes-ikke.json"), ["config_unreadable"]],
      "relativ sti": ["job-runner.json", ["config_path_not_absolute"]],
      "katalog": [join(dir, "dir.json"), ["config_not_a_regular_file"]],
      "symlenke (O_NOFOLLOW)": [join(dir, "link.json"), ["config_unreadable"]],
      "for stor (65 KiB)": [await write("big.json", ` ${"x".repeat(65 * 1024)}`, 0o644), ["config_too_large"]],
      "verdensskrivbar": [await write("world.json", valid, 0o666), ["config_writable_by_group_or_others"]],
      "gruppeskrivbar": [await write("group.json", valid, 0o664), ["config_writable_by_group_or_others"]],
      "ikke-root-eid (tjenesten kan ikke eie sin egen policy)": [real, ["config_must_be_owned_by_root", "config_unreadable"]],
      "ugyldig JSON": [await write("bad.json", "{ikke json", 0o644), ["config_must_be_owned_by_root", "config_not_valid_json"]],
      "ukjent nøkkel": [await write("unknown.json", JSON.stringify({ version: 1, runner: {}, image: "x" }), 0o644), ["config_must_be_owned_by_root", "config_unknown_key"]]
    };
    for (const entry of ["server.mjs", "egress-proxy.mjs"]) {
      for (const [label, [configPath, codes]] of Object.entries(cases)) {
        const r = spawnSync(process.execPath, [new URL(`../${entry}`, import.meta.url).pathname], { env: { PATH: "/usr/bin:/bin", JARVIS_JOB_RUNNER_CONFIG: configPath }, encoding: "utf8", timeout: 30_000 });
        expect(r.status, `${entry} ${label}: ${r.stderr}`).toBe(1);
        const fatal = JSON.parse(r.stderr.trim().split("\n").pop() ?? "{}");
        expect(fatal.event, `${entry} ${label}`).toBe("fatal");
        expect(codes, `${entry} ${label}: ${fatal.code}`).toContain(fatal.code);
        expect(r.stdout, `${entry} ${label}`).toBe("");
        expect(r.stderr, `${entry} ${label}`).not.toMatch(/at \w+.*\(.*:\d+:\d+\)|node:internal/); // ingen stacktrace
      }
    }
    await expect(lstat(join(dir, "x.sock"))).rejects.toThrow(); // ingen socket ble laget av noen av dem
    // uten JARVIS_JOB_RUNNER_CONFIG brukes /etc/jarvis/job-runner.json: finnes den ikke her, starter ingenting
    if (!(await lstat("/etc/jarvis/job-runner.json").then(() => true, () => false))) {
      const r = spawnSync(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 30_000 });
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stderr.trim().split("\n").pop() ?? "{}").code).toBe("config_unreadable");
    }
  }, 120_000);

  it("uid-sjekken er PÅ i produksjon: container-brukeren må ha tjenestens uid (runneren må eie filene agenten skriver), ellers starter ingenting", async () => {
    const h = await harness({ autoStart: false });
    const { createRunnerService } = await import("../server.mjs");
    const uid = process.getuid?.() ?? 0;
    for (const user of [`${uid + 1}:${uid + 1}`, `${uid + 1}:${uid}`, `${uid + 4000}:${uid + 4000}`]) {
      const config = { ...h.config, policy: { ...h.config.policy, user } };
      const strict = await createRunnerService({ config, dockerExec: h.fake.exec, testOverrides: { allowAnyOwner: true } });
      await expect(strict.start(), user).rejects.toMatchObject({ code: "container_user_must_equal_service_uid" });
      expect(strict.server, user).toBeUndefined();
    }
    expect(mutations(h)).toEqual([]);
  });

  it("PAT-filen (source: file): feil modus (også gruppe-lesbar), tom, ugyldig, symlenke, mangler -> create gir 502 git_credential_unavailable uten ETT eneste git-/docker-kall og uten rester", async () => {
    const spy = await createGitSpy();
    const h = await harness({ runner: { git_bin: spy.gitBin } });
    const patFile = h.config.gitCredentials["owner/repo"].tokenFile;
    const original = await readFile(patFile, "utf8");
    const gitCalls = async () => (await spy.calls()).length;
    const cases = {
      "modus 0640 (gruppe kan lese)": async () => chmod(patFile, 0o640), "modus 0644": async () => chmod(patFile, 0o644), "modus 0660": async () => chmod(patFile, 0o660),
      "tom": async () => writeFile(patFile, ""), "mellomrom midt i": async () => writeFile(patFile, "ghp_a b"), "linjeskift midt i": async () => writeFile(patFile, "ghp_aaaaaaaaaaaa\nghp_bbbbbbbbbbbb"),
      "kolon (credential-protokoll)": async () => writeFile(patFile, "ghp_aaaa:bbbbbbbbbb"), "for stor": async () => writeFile(patFile, `ghp_${"a".repeat(17 * 1024)}`),
      "symlenke til gyldig fil": async () => { const real = `${patFile}.real`; await writeFile(real, original, { mode: 0o600 }); await rm(patFile); await symlink(real, patFile); },
      "mangler": async () => rm(patFile)
    };
    const before = await snapshot(h);
    const gitBefore = await gitCalls();
    for (const [label, mutate] of Object.entries(cases)) {
      await rm(patFile, { force: true });
      await writeFile(patFile, original, { mode: 0o600 });
      await mutate();
      const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
      expect(r.status, label).toBe(502);
      expect(r.json.error, label).toBe("git_credential_unavailable");
      expect(r.text, label).not.toContain(original.trim());
      expect(r.text, label).not.toContain(h.baseDir);
    }
    await expectNoSideEffects(h, before, "ødelagt PAT");
    expect(await gitCalls(), "ingen git-prosess startet").toBe(gitBefore);
    // og når filen er i orden igjen virker alt (ingen stille tilstand sitter fast)
    await rm(patFile, { force: true });
    await writeFile(patFile, original, { mode: 0o600 });
    expect((await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } })).status).toBe(201);
  }, 60_000);

  it("docker-daemonen forsvinner midt i driften: create gir 503 uten rester; exec/DELETE gir kontrollerte feil, og jobben kan ryddes når daemonen er tilbake", async () => {
    const h = await harness();
    const job = await h.createJob();
    h.fake.state.daemonDown = true;
    const before = await snapshot(h);
    const create = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(create.status).toBe(503);
    expect(create.json.error).toBe("job_network_missing");
    expect((await readdir(h.baseDir)).sort()).toEqual(before.dirs); // ingen ny jobbkatalog
    const exec = await h.exec(job.job_id, ["true"]);
    expect(exec.status).toBe(200); // docker feilet: kommandoen fikk en ikke-null exitkode, ikke et 5xx-krasj
    expect(exec.json.code).not.toBe(0);
    const del = await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    expect(del.status).toBe(202); // container kunne ikke fjernes: cleanup_pending, jobbplassen holdes
    expect(del.json).toEqual({ deleted: false, state: "cleanup_pending" });
    h.fake.state.daemonDown = false;
    await h.service.manager.sweep();
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.fake.containers.size).toBe(0);
    expect((await readdir(h.baseDir)).filter((e) => e !== ".runner")).toEqual([]);
  }, 60_000);
});

describe("E: samtidighet, tak, TTL, tidsavbrudd og flom", () => {
  const waitFor = async (predicate, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
  const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; };

  it("storm: 48 klienter med tilfeldige create/exec/publish/DELETE i bølger mot maks 3 jobber - aldri over taket, aldri 500, og NULL rester til slutt (jobber, containere, kataloger, hemmeligheter)", async () => {
    const h = await harness({ runner: { max_concurrent_jobs: 3 } });
    const baselineSecrets = h.registry.size;
    const statuses = [];
    let peak = 0;
    const sampler = setInterval(() => { peak = Math.max(peak, h.service.manager.activeJobs); }, 5);
    const client = async (i) => {
      const rnd = lcg(7000 + i);
      const created = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo", task_id: `storm-${i}`, env: { ANTHROPIC_API_KEY: `sk-ant-api03-storm-${i}-0123456789` } } });
      statuses.push(created.status);
      if (created.status !== 201) return;
      const id = created.json.job_id;
      const ops = [];
      for (let k = 0, n = 2 + Math.floor(rnd() * 4); k < n; k += 1) {
        const pick = rnd();
        if (pick < 0.3) ops.push(h.exec(id, ["sh", "-c", `echo ${i} > f${k}.txt && git checkout -q -B jarvis/s${i} && git add -A && git commit -q -m s${i}`]));
        else if (pick < 0.5) ops.push(h.exec(id, ["sleep", "0.15"]));
        else if (pick < 0.7) ops.push(h.api({ method: "POST", path: `/v1/jobs/${id}/publish`, body: { branch: `jarvis/s${i}-${k}` } }));
        else if (pick < 0.85) ops.push(h.api({ method: "DELETE", path: `/v1/jobs/${id}` }));
        else ops.push(h.exec(id, ["sleep", "5"], { timeout_ms: 1000 }));
      }
      for (const r of await Promise.all(ops)) statuses.push(r.status);
      statuses.push((await h.api({ method: "DELETE", path: `/v1/jobs/${id}` })).status);
    };
    for (let wave = 0; wave < 4; wave += 1) await Promise.all(Array.from({ length: 12 }, (_, i) => client(wave * 12 + i)));
    clearInterval(sampler);
    expect(peak).toBeLessThanOrEqual(3);
    expect(statuses.filter((s) => s >= 500), `statuser: ${JSON.stringify([...new Set(statuses)].sort())}`).toEqual([]);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThan(3);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0); // taket ble faktisk truffet
    await h.service.manager.sweep();
    for (const id of [...h.service.manager.jobs.keys()]) await h.api({ method: "DELETE", path: `/v1/jobs/${id}` });
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.fake.containers.size).toBe(0);
    expect((await readdir(h.baseDir)).filter((e) => e !== ".runner")).toEqual([]);
    expect(h.registry.size, "hemmelighetsregisteret er tilbake til utgangspunktet").toBe(baselineSecrets);
    expect(h.logLines.filter((l) => l.includes('"internal_error"'))).toEqual([]);
  }, 180_000);

  it("10 samtidige exec på samme jobb: NØYAKTIG én kjører, de andre får 409 job_busy (aldri to prosesser i samme container samtidig)", async () => {
    const h = await harness();
    const job = await h.createJob();
    const results = await Promise.all(Array.from({ length: 10 }, () => h.exec(job.job_id, ["sleep", "0.4"])));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const busy = results.filter((r) => r.status === 409);
    expect(busy).toHaveLength(9);
    expect(busy.every((r) => r.json.error === "job_busy")).toBe(true);
  });

  it("TTL mens en exec pågår: sweep() dreper containeren, exec-kallet får 409 job_cancelled, katalogen og plassen er borte", async () => {
    let now = Date.parse("2026-10-09T00:00:00.000Z");
    const h = await harness({ now: () => now, runner: { max_job_lifetime_s: 60 } });
    const job = await h.createJob();
    const name = `jarvis-job-${job.job_id}`;
    const pending = h.exec(job.job_id, ["sleep", "30"], { timeout_ms: 60_000 });
    expect(await waitFor(() => (h.fake.running.get(name)?.size ?? 0) > 0)).toBe(true);
    now += 120_000;
    await h.service.manager.sweep();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("job_cancelled");
    expect(h.fake.containers.size).toBe(0);
    expect(h.service.manager.activeJobs).toBe(0);
    expect((await readdir(h.baseDir)).filter((e) => e !== ".runner")).toEqual([]);
    expect((await h.exec(job.job_id, ["true"])).status).toBe(404);
  }, 60_000);

  it("tidsavbrudd: exec over policyens grense avvises, nøyaktig grensen godtas, og et tidsavbrudd dreper HELE containeren (code 124, senere kall 409 job_terminated) - også mot en bakgrunnsprosess som overlever kommandoen", async () => {
    const h = await harness({ runner: { max_exec_timeout_ms: 5000, default_exec_timeout_ms: 2000 } });
    const job = await h.createJob();
    expect((await h.exec(job.job_id, ["true"], { timeout_ms: 5001 })).status).toBe(400);
    expect((await h.exec(job.job_id, ["true"], { timeout_ms: 5000 })).status).toBe(200);
    const slow = await h.exec(job.job_id, ["sh", "-c", "(sleep 30 &) ; sleep 30"], { timeout_ms: 1000 });
    expect(slow.status).toBe(200);
    expect(slow.json).toMatchObject({ code: 124, timed_out: true });
    expect(slow.json.stderr).toContain("job_exec_timeout");
    expect(h.fake.containers.size).toBe(0);
    for (const r of [await h.exec(job.job_id, ["true"]), await h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch: "jarvis/x" } })]) {
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("job_terminated");
    }
    expect((await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` })).json).toEqual({ deleted: true, state: "gone" });
  }, 60_000);

  it("output-flom: 40 MB fra agenten kuttes ved policyens tak (stdout+merke), svaret er lite, og kommandoen får aldri minnet til å vokse i runneren", async () => {
    const h = await harness({ runner: { max_output_bytes: 2048 } });
    const job = await h.createJob();
    const before = process.memoryUsage().rss;
    const r = await h.exec(job.job_id, ["node", "-e", 'const b="x".repeat(1<<20);for(let i=0;i<40;i++){process.stdout.write(b);process.stderr.write(b)}'], { timeout_ms: 30_000 });
    expect(r.status).toBe(200);
    expect(r.json.truncated).toBe(true);
    expect(r.json.stdout.length).toBeLessThanOrEqual(2048);
    expect(r.json.stderr.length).toBeLessThanOrEqual(2048 + 40);
    expect(r.text.length).toBeLessThan(8192);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
  }, 60_000);

  it("body-flom: 40 parallelle forespørsler over taket (256 KiB) gir 413 (eller avbrutt forbindelse), aldri en jobb, og tjenesten svarer normalt etterpå", async () => {
    const h = await harness();
    const before = await snapshot(h);
    const big = JSON.stringify({ repo: "owner/repo", pad: "y".repeat(300_000) });
    const results = await Promise.all(Array.from({ length: 40 }, () => h.api({ method: "POST", path: "/v1/jobs", rawBody: big }).then((r) => r.status, () => "reset")));
    expect(results.every((s) => s === 413 || s === "reset")).toBe(true);
    expect(results.filter((s) => s === 413).length).toBeGreaterThan(0);
    await expectNoSideEffects(h, before, "body-flom");
    expect((await h.api({ path: "/v1/health" })).status).toBe(200);
    // chunked uten Content-Length stoppes også ved taket (strømmes ikke ubegrenset inn i minnet)
    const chunked = await raw(h.socketPath, `POST /v1/jobs HTTP/1.1\r\nHost: r\r\n${AUTH}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${(300_000).toString(16)}\r\n${"y".repeat(300_000)}\r\n0\r\n\r\n`, { idleMs: 1000 });
    expect(chunked.statuses.length === 0 || chunked.statuses[0] === 413).toBe(true);
  }, 60_000);

  it("klient som kobler fra midt i publish: pushen avbrytes eller fullføres atomisk, jobben er terminated/ryddet - aldri en hengende prosess eller en foreldreløs container", async () => {
    const h = await harness();
    const job = await h.createJob();
    await h.exec(job.job_id, ["sh", "-c", "echo x > f.txt && git checkout -q -b jarvis/c && git add -A && git commit -q -m c"]);
    await new Promise((resolve) => {
      const socket = net.connect(h.socketPath);
      const body = JSON.stringify({ branch: "jarvis/c" });
      socket.write(`POST /v1/jobs/${job.job_id}/publish HTTP/1.1\r\nHost: r\r\n${AUTH}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      socket.destroy(); // borte før svaret
      setTimeout(resolve, 20);
    });
    // etterpå: jobben er enten fortsatt brukbar eller terminert, men aldri «busy» for alltid
    expect(await waitFor(async () => (await h.exec(job.job_id, ["true"])).status !== 409 || h.service.manager.jobs.get(job.job_id)?.state === "terminated", 15_000)).toBe(true);
    await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.fake.containers.size).toBe(0);
  }, 60_000);
});

describe("F: agenten angriper runner-eide stier (worst case: i testen KAN «containeren» nå ../private - i produksjon er den ikke montert)", () => {
  const exists = (path) => lstat(path).then(() => true, () => false);
  const commit = (h, id, script = "echo ok > f.txt && git checkout -q -b jarvis/f && git add -A && git commit -q -m f") => h.exec(id, ["sh", "-c", script]);
  const publish = (h, id, branch = "jarvis/f") => h.api({ method: "POST", path: `/v1/jobs/${id}/publish`, body: { branch } });

  it("agenten overskriver base.git/config og hooks (fsmonitor, packObjectsHook, sshCommand, credential.helper, url.insteadOf, include) og plasserer hooks overalt: publish lykkes, og INGENTING av det kjørte på verten", async () => {
    const h = await harness();
    const job = await h.createJob();
    const priv = join(h.baseDir, job.job_id, "private");
    const marker = join(h.root, "PWNED");
    const hook = `#!/bin/sh\ntouch '${marker}'\nexit 0\n`;
    const evil = `[core]\n\tfsmonitor = touch ${marker}\n\tsshCommand = touch ${marker}\n\thooksPath = ${join(priv, "hooks")}\n[uploadpack]\n\tpackObjectsHook = touch ${marker}\n[credential]\n\thelper = !touch ${marker}\n[url "file:///etc/"]\n\tinsteadOf = https://github.com/\n[include]\n\tpath = ${join(priv, "evil.inc")}\n[alias]\n\tbundle = !touch ${marker}\n`;
    await writeFile(join(priv, "evil.inc"), `[core]\n\tfsmonitor = touch ${marker}\n`);
    await writeFile(join(priv, "base.git", "config"), evil);
    await mkdir(join(priv, "hooks"), { recursive: true });
    for (const dir of [join(priv, "hooks"), join(priv, "base.git", "hooks")]) {
      await mkdir(dir, { recursive: true });
      for (const name of ["pre-receive", "update", "post-update", "reference-transaction", "pre-push", "pre-commit", "post-checkout", "post-merge", "post-fetch", "fsmonitor-watchman", "pre-auto-gc", "push-to-checkout", "proc-receive"]) {
        await writeFile(join(dir, name), hook, { mode: 0o755 });
      }
    }
    await commit(h, job.job_id);
    const pub = await publish(h, job.job_id);
    expect(pub.status, pub.text).toBe(200);
    expect(await exists(marker), "en plantet hook/config kjørte på VERTEN").toBe(false);
    expect(gitSync(h.origins["owner/repo"].dir, ["rev-parse", "jarvis/f"])).toBe(pub.json.commit_sha);
  }, 60_000);

  it("agenten sletter/ødelegger base.git (objekter borte, tom pakke): publish feiler LUKKET (4xx/5xx med stabil kode), og ingenting pushes", async () => {
    const h = await harness();
    const origin = h.origins["owner/repo"].dir;
    const refsBefore = gitSync(origin, ["for-each-ref", "--format=%(refname)"]);
    for (const attack of ["objekter slettet", "hele base.git slettet", "objects-katalogen er en fil"]) {
      const job = await h.createJob();
      const base = join(h.baseDir, job.job_id, "private", "base.git");
      await commit(h, job.job_id);
      if (attack === "objekter slettet") await rm(join(base, "objects"), { recursive: true, force: true });
      else if (attack === "hele base.git slettet") await rm(base, { recursive: true, force: true });
      else { await rm(join(base, "objects"), { recursive: true, force: true }); await writeFile(join(base, "objects"), "ikke en katalog"); }
      const pub = await publish(h, job.job_id);
      expect(pub.status, `${attack}: ${pub.text}`).toBeGreaterThanOrEqual(400);
      expect(typeof pub.json.error, attack).toBe("string");
      expect(pub.text, attack).not.toContain(h.baseDir);
      await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    }
    expect(gitSync(origin, ["for-each-ref", "--format=%(refname)"])).toBe(refsBefore);
  }, 60_000);

  it("plantede symlenker på runnerens skrivestier (out.bundle, verify.git) følges ALDRI: målene utenfor er uendret etter publish", async () => {
    const h = await harness();
    const job = await h.createJob();
    const priv = join(h.baseDir, job.job_id, "private");
    const sentinelFile = join(h.root, "sentinel-file.txt");
    const sentinelDir = join(h.root, "sentinel-dir");
    await writeFile(sentinelFile, "ORIGINAL");
    await mkdir(sentinelDir);
    await writeFile(join(sentinelDir, "keep.txt"), "ORIGINAL");
    await symlink(sentinelFile, join(priv, "out.bundle"));
    await symlink(sentinelDir, join(priv, "verify.git"));
    await commit(h, job.job_id);
    const pub = await publish(h, job.job_id);
    expect(pub.status, pub.text).toBe(200);
    expect(await readFile(sentinelFile, "utf8")).toBe("ORIGINAL");
    expect(await readdir(sentinelDir)).toEqual(["keep.txt"]);
    expect(await readFile(join(sentinelDir, "keep.txt"), "utf8")).toBe("ORIGINAL");
  }, 60_000);

  it("agenten river .git og lager en helt ny historie (orphan, annen rot): publish nektes (bundlen bygger ikke på basen), ingenting pushes", async () => {
    const h = await harness();
    const origin = h.origins["owner/repo"].dir;
    const refsBefore = gitSync(origin, ["for-each-ref", "--format=%(refname)"]);
    const job = await h.createJob();
    await h.exec(job.job_id, ["sh", "-c", "rm -rf .git && git init -q && git checkout -q -b jarvis/f && echo x > f.txt && git add -A && git commit -q -m orphan"]);
    const pub = await publish(h, job.job_id);
    expect(pub.status, pub.text).toBeGreaterThanOrEqual(400);
    expect(gitSync(origin, ["for-each-ref", "--format=%(refname)"])).toBe(refsBefore);
  }, 60_000);

  it("symlenker i /work ut av jobben (til /etc, jobbens egen rot, en annen jobb) følges ikke ved DELETE: ingen annen jobb eller vertsfil blir berørt", async () => {
    const h = await harness({ runner: { max_concurrent_jobs: 2 } });
    const victim = await h.createJob();
    const attacker = await h.createJob();
    const victimFile = join(h.baseDir, victim.job_id, "work", "README.md");
    expect(await exists(victimFile)).toBe(true);
    await h.exec(attacker.job_id, ["sh", "-c", `ln -s /etc etc-link && ln -s ${h.baseDir} base-link && ln -s ${join(h.baseDir, victim.job_id)} victim-link && ln -s ../../${victim.job_id} rel-link && ln -s ${h.root} root-link`]);
    expect((await h.api({ method: "DELETE", path: `/v1/jobs/${attacker.job_id}` })).json).toEqual({ deleted: true, state: "gone" });
    expect(await exists(victimFile)).toBe(true);
    expect(await exists("/etc/passwd")).toBe(true);
    expect(await exists(h.baseDir)).toBe(true);
    expect(await exists(h.root)).toBe(true);
    expect((await h.exec(victim.job_id, ["true"])).status).toBe(200);
  }, 60_000);
});

describe("G: kanarifugler - ingen hemmelighet i noe svar, logglinje, docker-/git-argv eller fil på disk", () => {
  it("bearer-token, PAT, Anthropic-nøkkel og kortlevd git-token gjennom suksess OG feil: ingen lekkasje, ingen interne stier i svar", async () => {
    const spy = await createGitSpy();
    const API_KEY = "sk-ant-api03-KANARI-0123456789-abcdefghijkl";
    const REQ_TOKEN = syntheticInstallationToken(420, 9);
    const h = await harness({ slugs: ["owner/file", "owner/req"], requestTokenSlugs: ["owner/req"], runner: { git_bin: spy.gitBin, max_concurrent_jobs: 4 } });
    const secrets = { bearer: RUNNER_TOKEN, pat: h.gitToken, api: API_KEY, request: REQ_TOKEN };
    /** @type {string[]} */
    const responses = [];
    const call = async (args) => { const r = await h.api(args); responses.push(`${r.status} ${r.text}`); return r; };
    const create = (body) => call({ method: "POST", path: "/v1/jobs", body });

    // SUKSESS: file-repo med Anthropic-nøkkel; agenten skriver ut miljøet sitt (verdien skal maskeres i svaret)
    const file = (await create({ repo: "owner/file", env: { ANTHROPIC_API_KEY: API_KEY } })).json;
    const printed = await call({ method: "POST", path: `/v1/jobs/${file.job_id}/exec`, body: { argv: ["sh", "-c", "printenv HOME; printenv ANTHROPIC_API_KEY; echo \"$ANTHROPIC_API_KEY\" >&2"] } });
    expect(printed.json.stdout).toContain("[REDACTED]");
    await call({ method: "POST", path: `/v1/jobs/${file.job_id}/exec`, body: { argv: ["sh", "-c", "echo a > a.txt && git checkout -q -b jarvis/k1 && git add -A && git commit -q -m k1"] } });
    expect((await call({ method: "POST", path: `/v1/jobs/${file.job_id}/publish`, body: { branch: "jarvis/k1" } })).status).toBe(200);
    // FEIL: tidsavbrudd med hemmelighet i miljøet, ugyldig branch, token til file-repo, ukjent repo
    await call({ method: "POST", path: `/v1/jobs/${file.job_id}/publish`, body: { branch: "main" } });
    await call({ method: "POST", path: "/v1/jobs", body: { repo: "owner/file", git_token: REQ_TOKEN } });
    await call({ method: "POST", path: "/v1/jobs", body: { repo: "evil/repo", env: { ANTHROPIC_API_KEY: API_KEY } } });
    // request-repo: mangler token / feil type hemmelighet i git_token / samme verdi i env / gyldig token (klone + publish med nytt token)
    await create({ repo: "owner/req" });
    await create({ repo: "owner/req", git_token: API_KEY });
    await create({ repo: "owner/req", git_token: REQ_TOKEN, env: { ANTHROPIC_API_KEY: REQ_TOKEN } });
    const req = (await create({ repo: "owner/req", git_token: REQ_TOKEN, env: { ANTHROPIC_API_KEY: API_KEY } })).json;
    await call({ method: "POST", path: `/v1/jobs/${req.job_id}/exec`, body: { argv: ["sh", "-c", "echo b > b.txt && git checkout -q -b jarvis/k2 && git add -A && git commit -q -m k2"] } });
    expect((await call({ method: "POST", path: `/v1/jobs/${req.job_id}/publish`, body: { branch: "jarvis/k2", git_token: syntheticInstallationToken(420, 10) } })).status).toBe(200);
    // feil som ekkoer: docker-feil, uautentisert med hemmeligheter som «bearer»
    h.fake.state.failCreate = true;
    await create({ repo: "owner/file", env: { ANTHROPIC_API_KEY: API_KEY } });
    h.fake.state.failCreate = false;
    for (const wrong of [h.gitToken, API_KEY, REQ_TOKEN]) await h.api({ token: wrong, path: "/v1/health" }).then((r) => responses.push(`${r.status} ${r.text}`));
    const timeout = await call({ method: "POST", path: `/v1/jobs/${file.job_id}/exec`, body: { argv: ["sleep", "5"], timeout_ms: 1000 } });
    expect(timeout.json.timed_out).toBe(true);
    for (const id of [file.job_id, req.job_id]) await call({ method: "DELETE", path: `/v1/jobs/${id}` });

    const everything = {
      "svar": responses.join("\n"),
      "logg": h.logLines.join("\n"),
      "docker-argv": h.fake.calls.map((c) => c.args.join("\u0000")).join("\n"),
      "git-argv": (await spy.calls()).map((c) => c.argv.join("\u0000")).join("\n")
    };
    for (const [where, text] of Object.entries(everything)) {
      for (const [name, value] of Object.entries(secrets)) expect(text.includes(value), `${name} lekket i ${where}`).toBe(false);
    }
    // ingen intern sti (base_dir, testrot) i noe svar
    expect(everything["svar"]).not.toContain(h.baseDir);
    expect(everything["svar"]).not.toContain(h.root);
    // docker-prosessens miljø bar Anthropic-nøkkelen KUN som ANTHROPIC_API_KEY og kun for create/exec; aldri PAT/bearer/git-token
    for (const call2 of h.fake.calls) {
      for (const [k, v] of Object.entries(call2.env)) {
        if (v === API_KEY) expect(k).toBe("ANTHROPIC_API_KEY");
        for (const s of [secrets.bearer, secrets.pat, secrets.request]) expect(v === s, `${s.slice(0, 8)} i docker-env ${k}`).toBe(false);
      }
    }
    // filer: runner-token, PAT og git-token finnes ikke i noen fil under test-roten (utenom selve token-/PAT-filene)
    const patterns = join(h.root, "patterns.txt");
    await writeFile(patterns, `${Object.values(secrets).join("\n")}\n`);
    const grep = spawnSync("grep", ["-rIlF", "-f", patterns, "--exclude=patterns.txt", "--exclude=token", "--exclude=git-token-*", "--exclude=*.real", h.root], { encoding: "utf8" });
    expect(grep.stdout.trim().split("\n").filter(Boolean), "filer med hemmeligheter").toEqual([]);
  }, 120_000);

  it("interne stier (jobbkatalogen, installasjonskatalogen) står ikke i feildetaljer fra docker eller git: scrubPaths erstatter lengste prefiks først, og DockerClient.detail bruker den", async () => {
    expect(scrubPaths("fatal: '/var/lib/jarvis-job-runner/jobs/abc/private/out.bundle' er ikke en bundle; /opt/jarvis-job-runner/ops/x.mjs", [["/var/lib/jarvis-job-runner/jobs", "<jobs>"], ["/opt/jarvis-job-runner", "<runner>"]]))
      .toBe("fatal: '<jobs>/abc/private/out.bundle' er ikke en bundle; <runner>/ops/x.mjs");
    expect(scrubPaths("/a/b/c og /a/b", [["/a/b", "<kort>"], ["/a/b/c", "<lang>"]])).toBe("<lang> og <kort>"); // lengste først
    expect(scrubPaths("ingenting her", [["/", "<x>"], ["", "<y>"]])).toBe("ingenting her"); // tomme/rot-prefikser gjør ingenting
    const exec = async () => ({ status: 125, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from("docker: Error response from daemon: invalid mount config: bind source path does not exist: /var/lib/jarvis-job-runner/jobs/x/work"), timedOut: false, truncated: false, cancelled: false });
    const docker = new DockerClient({ exec, registry: new SecretRegistry(), scrub: [["/var/lib/jarvis-job-runner/jobs", "<jobs>"]] });
    const error = await docker.create(["create"], {}).catch((e) => e);
    expect(error.code).toBe("container_create_failed");
    expect(error.detail).toContain("<jobs>/x/work");
    expect(error.detail).not.toContain("/var/lib/jarvis-job-runner");
  });

  it("svarformene er smale: create/health har nøyaktig de dokumenterte nøklene, og feilsvar er {error, detail?} - ingen stacktrace, ingen intern streng", async () => {
    const h = await harness();
    const health = await h.api({ path: "/v1/health" });
    expect(Object.keys(health.json).sort()).toEqual(["active_jobs", "api_version", "max_jobs", "status"]);
    const created = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(Object.keys(created.json).sort()).toEqual(["base_branch", "expires_at", "head_sha", "job_id", "workdir"]);
    expect(created.json.workdir).toBe("/work");
    const errors = [
      await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "x" } }), await h.api({ method: "GET", path: "/v1/nope" }), await h.api({ method: "POST", path: "/v1/jobs", rawBody: "{" }),
      await h.exec(created.json.job_id, []), await h.api({ token: "x".repeat(40), path: "/v1/health" })
    ];
    for (const e of errors) {
      expect(Object.keys(e.json).every((k) => k === "error" || k === "detail"), e.text).toBe(true);
      expect(e.json.error).toMatch(/^[a-z0-9_]+$/);
      expect(e.text).not.toMatch(/at \w+.*\(.*:\d+:\d+\)|node_modules|\.mjs|Error:|\/tmp\//);
    }
  });
});

describe("H: egress-proxy - obfuskerte og lurende mål når aldri en vert utenfor allowlisten (samme vert, port og DNS-validering som i drift)", () => {
  const allow = ["github.com:443", "api.github.com:443", "api.anthropic.com:443"];
  /** @param {string} authority */
  async function outcome(authority, resolved = ["140.82.112.3"]) {
    const proxy = new EgressProxy({ allow, allowedClientCidrs: [{ network: "127.0.0.0", prefix: 8 }], resolve: async () => resolved });
    try {
      const target = parseConnectTarget(authority);
      await proxy.validate(target.host, target.port);
      return `ok:${target.host}:${target.port}`;
    } catch (e) {
      return e?.reason ?? `other:${e}`;
    }
  }

  it("alt som ikke er EKSAKT en allowlistet vert:port nektes - desimal/hex/oktal-IP, brukerinfo, fragment, sti, punycode/lookalike, subdomene- og suffikstriks, feil port, mellomrom/kontrolltegn", async () => {
    const hostile = [
      "2130706433:443", "0x7f000001:443", "0x7f.0.0.1:443", "0177.0.0.1:443", "127.1:443", "127.0.0.1:443", "169.254.169.254:80", "[::1]:443", "::1:443", "[::ffff:127.0.0.1]:443", "localhost:443",
      "github.com@evil.com:443", "evil.com#github.com:443", "github.com:443@evil.com:443", "github.com/path:443", "github.com:443/path", "github.com:443?x=1", "http://github.com:443", "github.com:443 ", " github.com:443", "github.com\r\n:443", "github.com\u0000:443",
      "github.com.evil.com:443", "evil-github.com:443", "evilgithub.com:443", "xgithub.com:443", "github.co:443", "github.com.:80", "github.com:80", "github.com:8443", "github.com:0", "github.com:65536", "github.com:", "github.com", ":443", "",
      "api.github.com.evil.com:443", "www.github.com:443", "raw.githubusercontent.com:443", "githuЬ.com:443" /* kyrillisk Ь */, "xn--githb-1ra.com:443", "ɡithub.com:443" /* latin ɡ */, "ｇithub.com:443", "github。com:443", "a".repeat(300) + ".com:443"
    ];
    for (const authority of hostile) {
      const r = await outcome(authority);
      expect(r.startsWith("ok:"), `${JSON.stringify(authority.slice(0, 50))} -> ${r}`).toBe(false);
    }
    // de som ER samme tjeneste normaliseres og slippes til DNS-validering
    for (const authority of ["GITHUB.COM:443", "github.com.:443", "Api.GitHub.com:443", "github.com:0443"]) expect((await outcome(authority)).startsWith("ok:"), authority).toBe(true);
  });

  it("allowlistet navn som LØSES til noe ikke-offentlig nektes - IPv4/IPv6 i alle notasjoner, IPv4-mappet, NAT64, 6to4, blandet svar og tomt svar", async () => {
    const privateAnswers = [
      ["127.0.0.1"], ["10.0.0.5"], ["172.16.9.9"], ["192.168.1.1"], ["169.254.169.254"], ["100.64.0.1"], ["0.0.0.0"], ["255.255.255.255"], ["224.0.0.1"], ["::1"], ["::"], ["fe80::1"], ["fc00::1"], ["fd00::1"], ["ff02::1"],
      ["::ffff:127.0.0.1"], ["::ffff:7f00:1"], ["0:0:0:0:0:ffff:7f00:1"], ["::ffff:10.0.0.1"], ["64:ff9b::7f00:1"], ["64:ff9b::10.0.0.1"], ["64:ff9b:1::1"], ["2002:7f00:1::"], ["2002:0a00:0001::1"], ["::7f00:1"], ["fec0::1"],
      ["140.82.112.3", "10.0.0.1"], ["10.0.0.1", "140.82.112.3"], ["140.82.112.3", "::1"], [], ["not-an-ip"], [""], ["140.82.112.3 "], ["140.82.112.3\n127.0.0.1"]
    ];
    for (const answers of privateAnswers) {
      const r = await outcome("github.com:443", answers);
      expect(r.startsWith("ok:"), `${JSON.stringify(answers)} -> ${r}`).toBe(false);
    }
    expect(await outcome("github.com:443", ["140.82.112.3", "2606:50c0:8000::154"])).toBe("ok:github.com:443");
  });
});

describe("J: kildekodevakter - invariantene runbooken bygger på, låst mot regresjon (en ny shell-vei, avhengighet eller flagg-bygger må være et bevisst valg)", () => {
  const ROOT = new URL("../../../", import.meta.url).pathname;
  /** Alle runner-kildefiler (ikke test/) + den delte spesifikasjonen. */
  const sources = async () => {
    const out = [];
    const visit = async (dir) => {
      for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== "test") await visit(join(dir, e.name)); } else if (e.name.endsWith(".mjs")) out.push(join(dir, e.name));
      }
    };
    await visit("ops/job-runner");
    out.push("modules/tasks/src/job-container-spec.mjs");
    return out;
  };
  const text = async (file) => readFile(join(ROOT, file), "utf8");
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, ""); // uten kommentarer

  it("kun lib/process.mjs starter underprosesser, uten shell; ingen eval/new Function/vm/worker_threads/cluster/dynamisk import av ikke-node-moduler", async () => {
    const files = await sources();
    expect(files.length).toBeGreaterThan(10);
    const spawners = [];
    for (const f of files) {
      const c = code(await text(f));
      if (/\bchild_process\b/.test(c)) spawners.push(f);
      expect(c, `${f}: shell`).not.toMatch(/shell\s*:\s*true/);
      expect(c, `${f}: eval`).not.toMatch(/\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*["'`]|node:vm|node:worker_threads|node:cluster/);
      expect(c, `${f}: exec-varianter`).not.toMatch(/\b(?:execSync|execFileSync|spawnSync|execFile|exec)\s*\(\s*["'`]/);
    }
    expect(spawners).toEqual(["ops/job-runner/lib/process.mjs"]);
  });

  it("ingen eksterne avhengigheter: alle import-spesifikatorer er node:-innebygde eller relative filer innenfor runneren/spesifikasjonen", async () => {
    for (const f of await sources()) {
      const c = code(await text(f));
      for (const m of c.matchAll(/(?:^|\n)\s*(?:(?:import|export)\s[^;]*?from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
        const spec = m[1];
        expect(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"), `${f}: ${spec}`).toBe(true);
      }
      for (const m of c.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) expect((m[1] ?? "").startsWith("node:") || (m[1] ?? "").startsWith("."), `${f}: dynamisk ${m[1]}`).toBe(true);
    }
  });

  it("process.env leses kun for konfigstien (server.mjs, egress-proxy.mjs): runneren arver aldri miljøvariabler som styrer oppførsel", async () => {
    const users = [];
    for (const f of await sources()) {
      const c = code(await text(f));
      const hits = [...c.matchAll(/process\.env(?:\[\s*["']([A-Z_]+)["']\s*\]|\.([A-Z_]+))?/g)].map((m) => m[1] ?? m[2] ?? "*");
      if (hits.length > 0) users.push(`${f}:${[...new Set(hits)].join(",")}`);
    }
    // credential-helperen leser nøyaktig ÉN variabel (den flyktige per-kall-kanalen for token, via konstanten TOKEN_ENV); ingenting annet
    expect(users.sort()).toEqual(["ops/job-runner/credential-helper.mjs:*", "ops/job-runner/egress-proxy.mjs:JARVIS_JOB_RUNNER_CONFIG", "ops/job-runner/server.mjs:JARVIS_JOB_RUNNER_CONFIG"]);
    expect(code(await text("ops/job-runner/credential-helper.mjs")).match(/process\.env\[/g)).toHaveLength(1);
    expect(await text("ops/job-runner/credential-helper.mjs")).toContain('const TOKEN_ENV = "JARVIS_GIT_CREDENTIAL_TOKEN";');
  });

  it("docker-flaggene bygges KUN i den delte spesifikasjonen: runneren har ingen literal --privileged/--cap-add/--device/--volume/--pid/--ipc/--userns/--security-opt/-v/--mount, og docker.mjs kjenner fem literale underkommandoer + create (ferdig argv fra den delte byggeren) og exec", async () => {
    for (const f of (await sources()).filter((x) => x.startsWith("ops/job-runner/"))) {
      const c = code(await text(f));
      expect(c, f).not.toMatch(/["'`]--(?:privileged|cap-add|device|volume|pid|ipc|userns|security-opt|mount|network|publish|add-host|dns)\b/);
      expect(c, f).not.toMatch(/["'`]-v["'`]\s*,\s*["'`]\//); // «-v /vert:/container»
    }
    const docker = code(await text("ops/job-runner/lib/docker.mjs"));
    const subcommands = [...docker.matchAll(/this\.exec\(\s*\[\s*["']([a-z]+)["']/g)].map((m) => m[1]);
    expect([...new Set(subcommands)].sort()).toEqual(["network", "ps", "rm", "start", "version"]);
    expect(docker).toMatch(/\["exec",\s*"--workdir",\s*"\/work"/); // exec
    expect(docker).toMatch(/this\.exec\(createArgs/); // create: ferdig argv fra den delte byggeren
    const jobs = code(await text("ops/job-runner/lib/jobs.mjs"));
    expect(jobs.match(/buildJobContainerCreateArgs\(/g)).toHaveLength(1);
    expect(jobs).toMatch(/this\.docker\.create\(createArgs,/);
  });

  it("verten kjører aldri git i agentens katalog: workDir brukes kun som klone-mål (cwd = privateDir), som bind-mount-kilde, og av `remote remove` rett etter klonen - aldri som cwd/GIT_DIR/-C senere", async () => {
    const git = code(await text("ops/job-runner/lib/git.mjs"));
    const jobs = code(await text("ops/job-runner/lib/jobs.mjs"));
    expect(git.match(/\bworkDir\b/g)?.length ?? 0).toBe(3);
    expect(git).not.toMatch(/cwd:\s*p\.workDir/);
    expect(git).not.toMatch(/GIT_DIR:\s*p\.workDir/);
    const checkout = git.slice(git.indexOf("async createWorkCheckout"), git.indexOf("async verifyAndPush"));
    expect(checkout.match(/p\.workDir/g)?.length).toBe(3); // mkdir, klone-mål, `-C` (remote remove rett etter klonen, før containeren finnes)
    const verify = git.slice(git.indexOf("async verifyAndPush"));
    expect(verify).not.toMatch(/workDir/);
    const usages = [...jobs.matchAll(/\bworkDir\b/g)].length;
    expect(usages).toBeLessThanOrEqual(5); // definisjon, createWorkCheckout({workDir}), docker-bygger({workdir}) og doc
    expect(jobs).not.toMatch(/cwd:\s*job\.workDir/);
    expect(jobs).toMatch(/createWorkCheckout\(\{[^}]*cwd:\s*job\.privateDir/); // klonen kjøres fra jobbens PRIVATE katalog, aldri fra work/
  });

  it("alle host-git-kall har hooks av og én tillatt protokoll: git()-miljøet har tom HOME, ingen system-/global-config, og nettverkskallene bærer hardeningArgs", async () => {
    const git = code(await text("ops/job-runner/lib/git.mjs"));
    for (const must of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT", "GIT_ALLOW_PROTOCOL", "GIT_TEMPLATE_DIR", "GIT_NO_REPLACE_OBJECTS", "core.hooksPath=/dev/null", "protocol.allow=never", "http.followRedirects=false", "transfer.fsckObjects=true", "core.fsmonitor=false", "credential.helper="]) {
      expect(git + (await text("ops/job-runner/lib/credentials.mjs")), must).toContain(must);
    }
    // alle nettverkskall går gjennom netGit() (credential-helper + hardening), og netGit er eneste sted tokenet blir miljø
    expect(git.match(/this\.netGit\(/g)?.length).toBe(3); // ls-remote, fetch, push
    expect(git.match(/GIT_CREDENTIAL_TOKEN_ENV/g)?.length).toBe(2); // import + bruk i netGit
  });
});
