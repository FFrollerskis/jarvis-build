import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, gitSync } from "./support/harness.mjs";
import { apiRequest, RUNNER_TOKEN } from "./support/harness.mjs";

/**
 * WP-C1: akseptansescriptet (ops/job-runner/acceptance.sh) kjøres av EIER på NAS-en mot ekte Docker. Her testes det som KAN testes uten:
 * syntaks, tørrkjøring, avvisning av farlige/ufullstendige kall (aldri produksjonsrepoet), og hjelpefunksjonene (`api`, `create_job`, `cexec`,
 * `delete_job`, publish-svar) kjørt for ekte mot den EKTE vertstjenesten over Unix-socket (fake docker). Selve Docker-sjekkene (J03-J10, J12-J13)
 * er `NOT VERIFIED` til eieren kjører scriptet.
 */

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/job-runner/acceptance.sh");
const baseEnv = { PATH: process.env["PATH"], HOME: tmpdir(), LANG: "C.UTF-8" };

const run = (args, env = {}, input) => spawnSync("bash", [SCRIPT, ...args], { env: { ...baseEnv, ...env }, encoding: "utf8", input, timeout: 60_000 });

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
    const shims = await mkdtemp(join(tmpdir(), "wpc1-shims-"));
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

  it("repo som ikke står i runner.allowed_repos (f.eks. produksjonsrepoet) -> exit 2, ingen jobb opprettet", async () => {
    const { h, config } = await setup();
    const r = run([], { JARVIS_JOB_RUNNER_CONFIG: config, ACCEPTANCE_REPO: "tsworkflow/jarvisbuild" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("står ikke i runner.allowed_repos");
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

/** Starter tjenesten som egen prosess og returnerer stier + en stoppfunksjon. */
function startServe() {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./support/serve.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] });
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
async function setupServed() {
  const info = await startServe();
  served.push(info);
  const config = join(info.root, "job-runner.json");
  await writeFile(config, JSON.stringify({
    version: 1,
    runner: {
      socket_path: info.socketPath, token_file: info.tokenFile, base_dir: info.baseDir, network: "jarvis-jobs", image: `sha256:${"a".repeat(64)}`,
      allowed_repos: ["owner/repo"], git_credentials: { "owner/repo": { token_file: info.gitTokenFiles["owner/repo"] } }
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
