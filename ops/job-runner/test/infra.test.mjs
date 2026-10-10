import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { checkDockerfile } from "../../security/check-containment.mjs";
import { validateConfig } from "../lib/config.mjs";

/**
 * WP-C1: infrastrukturfilene (infra/job-runner/*) holder det de lover SÅ LANGT det kan bevises uten root/Docker/systemd/brannmur:
 * systemd-herding og minste-privilegium (tekstlig), jobb-imaget (pinnet base, lockfil med integritet, ikke-root), compose-overriden
 * (ingen Docker-socket), eksempelkonfigen (gyldig, men ubrukelig før image er satt), install-host.sh (--stage, idempotent, rører aldri
 * eierens konfig), setup-network.sh og build-job-image.sh (kjørt for ekte mot FALSKE docker/iptables) og at den installerte koden er
 * komplett. At brannmuren faktisk blokkerer noe er `NOT VERIFIED` til acceptance.sh (J07) er kjørt på verten.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const INFRA = join(ROOT, "infra/job-runner");
const read = (rel) => readFile(join(ROOT, rel), "utf8");
/** Synkron lesing ved describe-tid (vitest samler describe-blokker synkront). */
const readSync = (rel) => readFileSync(join(ROOT, rel), "utf8");
const BASH = ["/usr/bin/bash", "/bin/bash"].find((p) => existsSync(p)) ?? "bash";
const FAKE_TOOL = join(HERE, "support/fake-host-tool.mjs");

/** INI-lignende parser for systemd-enheter: { Seksjon: [[Nøkkel, Verdi], ...] } (kommentarer og tomme linjer hoppes over). */
function parseUnit(text) {
  const sections = {};
  let current;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      current = (sections[header[1]] ??= []);
      continue;
    }
    const kv = /^([A-Za-z0-9]+)=(.*)$/.exec(line);
    if (kv && current) current.push([kv[1], kv[2]]);
  }
  return sections;
}
const values = (unit, section, key) => (unit[section] ?? []).filter(([k]) => k === key).map(([, v]) => v);
const one = (unit, section, key) => {
  const v = values(unit, section, key);
  expect(v, `${section}.${key}`).toHaveLength(1);
  return v[0];
};

describe("A: systemd-enhetene - herding og minste-privilegium", () => {
  const runnerText = readSync("infra/job-runner/jarvis-job-runner.service");
  const proxyText = readSync("infra/job-runner/jarvis-egress-proxy.service");
  const runner = parseUnit(runnerText);
  const proxy = parseUnit(proxyText);

  it("begge enhetene: egen ikke-root bruker, ingen capabilities, strict filsystem, smal adressefamilie og syscall-filter", () => {
    for (const [name, unit] of [["runner", runner], ["proxy", proxy]]) {
      const user = one(unit, "Service", "User");
      expect(user, name).toMatch(/^jarvis-[a-z-]+$/);
      expect(["root", "0"], name).not.toContain(user);
      expect(one(unit, "Service", "NoNewPrivileges"), name).toBe("yes");
      expect(one(unit, "Service", "CapabilityBoundingSet"), name).toBe("");
      expect(one(unit, "Service", "AmbientCapabilities"), name).toBe("");
      expect(one(unit, "Service", "ProtectSystem"), name).toBe("strict");
      expect(one(unit, "Service", "ProtectHome"), name).toBe("yes");
      expect(one(unit, "Service", "PrivateTmp"), name).toBe("yes");
      expect(one(unit, "Service", "PrivateDevices"), name).toBe("yes");
      expect(one(unit, "Service", "RestrictAddressFamilies"), name).toBe("AF_UNIX AF_INET AF_INET6");
      expect(one(unit, "Service", "RestrictNamespaces"), name).toBe("yes");
      expect(one(unit, "Service", "RestrictSUIDSGID"), name).toBe("yes");
      expect(one(unit, "Service", "LockPersonality"), name).toBe("yes");
      expect(one(unit, "Service", "ProtectKernelModules"), name).toBe("yes");
      expect(one(unit, "Service", "ProtectKernelTunables"), name).toBe("yes");
      expect(one(unit, "Service", "ProtectControlGroups"), name).toBe("yes");
      expect(one(unit, "Service", "SystemCallFilter"), name).toBe("@system-service");
      expect(one(unit, "Service", "UMask"), name).toBe("0077");
      expect(one(unit, "Service", "LimitCORE"), name).toBe("0"); // ingen minnedump: bearer-token, PAT og kortlevde installasjonstokens ligger i prosessminnet
      expect(one(unit, "Service", "Restart"), name).toBe("on-failure");
      expect(values(unit, "Install", "WantedBy"), name).toEqual(["multi-user.target"]);
    }
  });

  it("job-runner: minnegrenser for hele enheten (A-F3) - MemoryHigh under MemoryMax, ingen swap, OOMPolicy=continue (git-barnet drepes, runneren overlever), og ingen LimitAS som ville truffet V8", () => {
    const mib = (text) => { const m = /^(\d+)([MG])$/.exec(text ?? ""); if (!m) throw new Error(`ugyldig størrelse: ${text}`); return Number(m[1]) * (m[2] === "G" ? 1024 : 1); };
    expect(one(runner, "Service", "MemoryAccounting")).toBe("yes");
    expect(mib(one(runner, "Service", "MemoryHigh"))).toBeLessThan(mib(one(runner, "Service", "MemoryMax")));
    expect(mib(one(runner, "Service", "MemoryMax"))).toBeLessThanOrEqual(8192);
    expect(mib(one(runner, "Service", "MemoryMax"))).toBeGreaterThanOrEqual(1024); // Node + git-barn under standardoppsettet må få plass
    expect(one(runner, "Service", "MemorySwapMax")).toBe("0");
    expect(one(runner, "Service", "OOMPolicy")).toBe("continue");
    expect(values(runner, "Service", "LimitAS")).toEqual([]); // adresserom-grensen settes KUN på git-barna (prlimit), ikke på Node (V8 reserverer GiB adresserom)
  });

  it("job-runner: docker-gruppen er KUN her; socket-gruppen er primærgruppe; skriver bare til state- og runtime-katalogen", () => {
    expect(one(runner, "Service", "User")).toBe("jarvis-runner");
    expect(one(runner, "Service", "Group")).toBe("jarvis-job-clients");
    expect(one(runner, "Service", "SupplementaryGroups")).toBe("docker");
    expect(one(runner, "Service", "ReadWritePaths")).toBe("/var/lib/jarvis-job-runner");
    expect(one(runner, "Service", "StateDirectory")).toBe("jarvis-job-runner");
    expect(one(runner, "Service", "StateDirectoryMode")).toBe("0700");
    // Socket-katalogen er PERSISTENT (under state-katalogen), ikke RuntimeDirectory: systemd fjerner en slik katalog ved hver stopp, og en bind-mount i
    // worker peker på selve katalog-inoden (ville pekt på en slettet katalog til worker ble startet på nytt).
    expect(values(runner, "Service", "RuntimeDirectory")).toEqual([]);
    expect(values(runner, "Service", "RuntimeDirectoryMode")).toEqual([]);
    expect(values(runner, "Unit", "Requires").join(" ").split(/\s+/).sort()).toEqual(["docker.service", "jarvis-egress-proxy.service"]);
    expect(values(runner, "Unit", "After").join(" ")).toContain("jarvis-egress-proxy.service");
    // proxyen er en HARD avhengighet (Requires, ikke Wants): feiler setup-network.sh, starter ikke runneren uten brannmurreglene
    expect(values(runner, "Unit", "Wants").join(" ")).not.toContain("jarvis-egress-proxy");
  });

  it("job-runner: reload = SIGHUP mot hovedprosessen (token roteres uten omstart; kjørende jobber berøres ikke)", async () => {
    expect(one(runner, "Service", "ExecReload")).toBe("/bin/kill -HUP $MAINPID");
    const server = await read("ops/job-runner/server.mjs");
    expect(server).toMatch(/process\.on\("SIGHUP"/);
  });

  it("egress-proxy: INGEN docker-gruppe, ingen skrivbare stier, egen bruker; nettverksoppsett kjøres som root via «+»-prefikset", () => {
    expect(one(proxy, "Service", "User")).toBe("jarvis-egress");
    expect(values(proxy, "Service", "SupplementaryGroups")).toEqual([]);
    expect(values(proxy, "Service", "ReadWritePaths")).toEqual([]);
    expect(one(proxy, "Service", "ExecStartPre")).toBe("+/opt/jarvis-job-runner/infra/job-runner/setup-network.sh");
    expect(runnerText).not.toMatch(/^User=root/m);
    expect(proxyText).not.toMatch(/^User=root/m);
  });

  it("koden kjøres fra root-eid /opt/jarvis-job-runner (aldri fra repoet eller worker-data); konfig-stien er eneste miljøvariabel", () => {
    for (const [name, unit, script] of [["runner", runner, "server.mjs"], ["proxy", proxy, "egress-proxy.mjs"]]) {
      expect(one(unit, "Service", "ExecStart"), name).toBe(`/usr/bin/env node /opt/jarvis-job-runner/ops/job-runner/${script}`);
      expect(values(unit, "Service", "Environment"), name).toEqual(["JARVIS_JOB_RUNNER_CONFIG=/etc/jarvis/job-runner.json"]);
      expect(values(unit, "Unit", "ConditionPathExists"), name).toEqual(["/etc/jarvis/job-runner.json"]);
    }
  });

  it("ingen hemmeligheter eller lekkasjeveier i enhetsfilene (ingen EnvironmentFile, ingen PAT/API-nøkkel, ingen docker.sock-montering)", () => {
    for (const text of [runnerText, proxyText]) {
      const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      expect(code).not.toMatch(/EnvironmentFile|PrivateNetwork=|ANTHROPIC|GITHUB_TOKEN|JARVIS_GIT_CREDENTIAL|password|secret/i);
      expect(code).not.toMatch(/docker\.sock/);
    }
  });

  it("enhetene forklarer ærlig at docker-gruppen er effektivt root (herdingen er ikke tillitsgrensen)", () => {
    expect(runnerText).toMatch(/EFFEKTIVT ROOT/);
    expect(runnerText).toMatch(/root-eid/);
  });

  it("systemd-analyze verify (kun hvis tilgjengelig): ingen syntaksfeil i enhetene", () => {
    const probe = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) return; // ikke tilgjengelig her; eieren kjører install-host.sh + systemctl daemon-reload på verten
    for (const unit of ["jarvis-job-runner.service", "jarvis-egress-proxy.service"]) {
      const r = spawnSync("systemd-analyze", ["verify", "--man=no", join(INFRA, unit)], { encoding: "utf8" });
      // verify klager på at /opt/-stier og brukere ikke finnes her; kun egentlige syntaksfeil teller
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/Unknown (key|section)|Invalid|Failed to parse|Missing '='/i);
    }
  });
});

describe("B: jobb-imaget og Claude Code-pinningen", () => {
  const dockerfile = readSync("infra/job-runner/Dockerfile.job");
  const pkg = JSON.parse(readSync("infra/job-runner/claude-code/package.json"));
  const lock = JSON.parse(readSync("infra/job-runner/claude-code/package-lock.json"));

  it("samme containment-kontroll som repoets øvrige Dockerfiler: base pinnet til digest, siste USER er ikke-root", () => {
    expect(checkDockerfile(dockerfile, "infra/job-runner/Dockerfile.job")).toEqual([]);
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
  });

  it("ingen hemmeligheter, ingen ARG/ENV med nøkler, ingen nettverksinstallasjon via pipe til shell, ingen COPY av repoet", () => {
    const code = dockerfile.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN|JARVIS_GIT|PASSWORD|SECRET/i);
    expect(code).not.toMatch(/^ARG\s/m);
    expect(code).not.toMatch(/curl[^\n]*\|\s*(ba)?sh|wget[^\n]*\|\s*(ba)?sh/i);
    expect(code).not.toMatch(/^COPY\s+\.\s|^ADD\s/m);
    expect(code).toMatch(/^COPY package\.json package-lock\.json \.\/$/m);
    expect(code).toMatch(/npm ci --omit=dev/);
    expect(code).not.toMatch(/--ignore-scripts|--omit=optional/); // postinstall kopierer plattformbinæren; valgfrie pakker bærer den
  });

  it("setuid/setgid-bitene fjernes fra alle filer i imaget (forsvar i dybden bak no-new-privileges + cap-drop ALL), FØR siste USER", () => {
    const code = dockerfile.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).toMatch(/RUN find \/ -xdev -type f \\\( -perm -4000 -o -perm -2000 \\\) -exec chmod a-s \{\} \+/);
    expect(code.indexOf("chmod a-s")).toBeGreaterThan(-1);
    expect(code.indexOf("chmod a-s")).toBeLessThan(code.indexOf("USER 10001:10001"));
  });

  it("telemetri og auto-oppdatering er slått av i imaget (containeren når kun proxyens allowlist)", () => {
    for (const flag of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_TELEMETRY=1", "DISABLE_ERROR_REPORTING=1", "GIT_TERMINAL_PROMPT=0"]) {
      expect(dockerfile).toContain(flag);
    }
  });

  it("Claude Code er pinnet EKSAKT (ingen område/tag) og lockfilen har registerlenke og sha512-integritet for HVER pakke", () => {
    expect(pkg.dependencies).toEqual({ "@anthropic-ai/claude-code": "2.1.286" });
    expect(pkg.private).toBe(true);
    expect(lock.lockfileVersion).toBe(3);
    const entries = Object.entries(lock.packages).filter(([name]) => name !== "");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const [name, info] of entries) {
      expect(info.version, name).toBe("2.1.286");
      expect(info.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\/@anthropic-ai\/claude-code[a-z0-9-]*\/-\/claude-code[a-z0-9-]*-2\.1\.286\.tgz$/);
      expect(info.integrity, name).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
    // plattformbinæren for linux/glibc (x64 og arm64) er med, ellers ville `claude` mangle i imaget
    for (const arch of ["x64", "arm64"]) expect(lock.packages[`node_modules/@anthropic-ai/claude-code-linux-${arch}`]?.version).toBe("2.1.286");
  });
});

describe("C: compose-overriden gir worker KUN socket-katalogen og tokenfilen", () => {
  const text = readSync("infra/job-runner/docker-compose.job-runner.yml");
  const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("kun tjenesten worker; ingen docker.sock, privilegier, capabilities, host-nettverk, delte navnerom, porter eller env_file", () => {
    expect(code.match(/^ {2}[A-Za-z0-9_-]+:\s*$/gm)).toEqual(["  worker:"]);
    for (const forbidden of [/docker\.sock/, /privileged:/, /cap_add:/, /network_mode:/, /^\s*pid:/m, /^\s*ipc:/m, /^\s*uts:/m, /^\s*userns_mode:/m, /^\s*ports:/m, /env_file:/, /security_opt:/, /devices:/, /^\s*user:/m, /^\s*image:/m]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("de to monteringene er read-only binds som feiler hvis verten mangler stien (aldri en stille tom mount)", () => {
    const binds = [...code.matchAll(/- type: bind\n\s+source: (\S+)\n\s+target: (\S+)\n\s+read_only: true\n\s+bind:\n\s+create_host_path: false/g)].map((m) => [m[1], m[2]]);
    expect(binds).toEqual([
      ["/var/lib/jarvis-job-runner/sock", "/run/jarvis-job-runner"],
      ["/etc/jarvis/job-runner.token", "/run/secrets/jarvis-job-runner-token"]
    ]);
    expect(code.match(/type: bind/g)).toHaveLength(2);
  });

  it("worker får socket-tilgang via NUMERISK gruppe (påkrevd variabel) og kun modus-/sti-env (aldri en token-verdi)", () => {
    expect(code).toMatch(/group_add:\n\s+- "\$\{JARVIS_JOB_RUNNER_GID:\?[^}]+\}"/);
    expect(code).toMatch(/JARVIS_JOB_RUNNER: "host"/);
    expect(code).toMatch(/JARVIS_JOB_RUNNER_SOCKET: "\/run\/jarvis-job-runner\/runner\.sock"/);
    expect(code).toMatch(/JARVIS_JOB_RUNNER_TOKEN_FILE: "\/run\/secrets\/jarvis-job-runner-token"/);
    expect(code).not.toMatch(/TOKEN: |SECRET|PASSWORD|API_KEY/);
  });

  it("monteringen peker på katalogen socket_path ligger i (eksempelkonfig OG runnerens standard), og containerstien er mount-målet + samme filnavn", async () => {
    const example = JSON.parse(await read("infra/job-runner/job-runner.example.json"));
    const source = /source: (\/var\/lib\/jarvis-job-runner\/sock)\n\s+target: (\S+)/.exec(code);
    expect(source).not.toBeNull();
    expect(dirname(example.runner.socket_path)).toBe(source[1]);
    expect(example.runner.socket_path).toBe(`${source[1]}/runner.sock`);
    expect(validateConfig({ ...example, runner: { ...example.runner, socket_path: undefined, image: `sha256:${"a".repeat(64)}` } }, { require: ["runner"] }).runner.socketPath)
      .toBe(example.runner.socket_path); // runnerens standard = eksempelets verdi
    expect(code).toContain(`JARVIS_JOB_RUNNER_SOCKET: "${source[2]}/runner.sock"`);
    expect(example.runner.token_file).toBe("/etc/jarvis/job-runner.token");
  });
});

const COMPOSE_PROBE = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
const HAS_COMPOSE = !COMPOSE_PROBE.error && COMPOSE_PROBE.status === 0;

describe.skipIf(!HAS_COMPOSE)("C2: den ekte Compose-CLI-en (uten daemon) fletter basen og overriden riktig", () => {
  /** `docker compose config --format json` mot basen (+ overriden). Krever ikke daemon; leser ikke .env fra repoet. */
  async function render(withOverride, extra = {}) {
    const dir = await mkdtemp(join(tmpdir(), "wpc1-compose-"));
    const envFile = join(dir, "check.env");
    const lines = ["INFISICAL_DB_PASSWORD", "JARVIS_BROWSER_GATEWAY_TOKEN_SECRET", "JARVIS_DB_ADMIN_PASSWORD", "LANGFUSE_DB_PASSWORD"].map((n) => `${n}=dummy-verdi-kun-for-config-0123456789abcdef`);
    for (const [k, v] of Object.entries(extra)) lines.push(`${k}=${v}`);
    await writeFile(envFile, `${lines.join("\n")}\n`);
    const files = ["-f", join(ROOT, "infra/local/docker-compose.yml"), ...(withOverride ? ["-f", join(INFRA, "docker-compose.job-runner.yml")] : [])];
    const r = spawnSync("docker", ["compose", "--env-file", envFile, ...files, "config", "--format", "json"], {
      encoding: "utf8", timeout: 60_000, env: { PATH: process.env["PATH"], HOME: dir, DOCKER_CONFIG: dir, DOCKER_HOST: "unix:///nonexistent-jarvis-wpc1.sock" }
    });
    return { status: r.status, stderr: (r.stderr ?? "").split("\n").filter((l) => !l.includes("level=warning")).join("\n"), json: r.status === 0 ? JSON.parse(r.stdout) : null };
  }

  it("med overriden: worker får gruppen, host-modus, to read-only binds og beholder hele herdingen; ingen docker.sock noe sted", async () => {
    const r = await render(true, { JARVIS_JOB_RUNNER_GID: "4242" });
    expect(r.status, r.stderr).toBe(0);
    const worker = r.json.services.worker;
    expect(worker.group_add).toEqual(["4242"]);
    expect(worker.environment).toMatchObject({
      JARVIS_JOB_RUNNER: "host", JARVIS_JOB_RUNNER_SOCKET: "/run/jarvis-job-runner/runner.sock", JARVIS_JOB_RUNNER_TOKEN_FILE: "/run/secrets/jarvis-job-runner-token"
    });
    // Compose-versjoner skriver `create_host_path: false` ulikt (noen utelater en `false`-verdi og gir `bind: {}`, andre skriver den ut). Verdien betyr det samme (aldri opprette vertssti), så en
    // utelatt verdi leses som false; en eksplisitt `true` (Docker lager stien selv) er fortsatt en feil og gir fortsatt rødt.
    const withDefaultBind = (volume) => ({ ...volume, bind: { create_host_path: false, ...(volume.bind ?? {}) } });
    expect(worker.volumes.map(withDefaultBind)).toEqual([
      { type: "bind", source: "/var/lib/jarvis-job-runner/sock", target: "/run/jarvis-job-runner", read_only: true, bind: { create_host_path: false } },
      { type: "bind", source: "/etc/jarvis/job-runner.token", target: "/run/secrets/jarvis-job-runner-token", read_only: true, bind: { create_host_path: false } }
    ]);
    expect(worker.read_only).toBe(true);
    expect(worker.cap_drop).toEqual(["ALL"]);
    expect(worker.security_opt).toEqual(["no-new-privileges:true"]);
    expect(worker.privileged).toBeUndefined();
    expect(JSON.stringify(r.json)).not.toContain("docker.sock");
    // ingen ANNEN tjeneste er berørt av overriden
    const base = await render(false);
    for (const [name, service] of Object.entries(r.json.services)) {
      if (name !== "worker") expect(service, name).toEqual(base.json.services[name]);
    }
  });

  it("uten overriden er worker uendret: ingen mounts, ingen ekstra gruppe, JARVIS_JOB_RUNNER tom (lukket)", async () => {
    const r = await render(false);
    expect(r.status, r.stderr).toBe(0);
    const worker = r.json.services.worker;
    expect(worker.environment.JARVIS_JOB_RUNNER).toBe("");
    expect(worker.volumes ?? []).toEqual([]);
    expect(worker.group_add ?? []).toEqual([]);
  });

  it("uten JARVIS_JOB_RUNNER_GID nekter Compose å lage konfigurasjonen (aldri en stille tom gruppe)", async () => {
    const r = await render(true);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("JARVIS_JOB_RUNNER_GID");
  });
});

describe("D: eksempelkonfigen", () => {
  it("er gyldig bortsett fra den nullede plassholder-image-ID-en: en uendret kopi kan ALDRI starte tjenesten", async () => {
    const example = JSON.parse(await read("infra/job-runner/job-runner.example.json"));
    expect(example.runner.image).toBe(`sha256:${"0".repeat(64)}`);
    expect(() => validateConfig(example, { require: ["runner", "egress_proxy"] })).toThrow(/placeholder_not_replaced/);
    const replaced = { ...example, runner: { ...example.runner, image: `sha256:${"a".repeat(64)}` } };
    const parsed = validateConfig(replaced, { require: ["runner", "egress_proxy"] });
    expect(parsed.runner.policy).toMatchObject({ user: "10001:10001", memory: "1g", pull: "never" });
    expect(parsed.runner.maxConcurrentJobs).toBe(2);
    expect(parsed.runner.publish.denyPaths).toEqual([".github/", ".gitmodules", ".gitattributes", ".lfsconfig"]);
    expect(example.runner.env_allow).toEqual(["ANTHROPIC_API_KEY"]); // eksempelet viser standarden eksplisitt: kun Anthropic-nøkkelen worker leverer
    expect(parsed.runner.envAllow).toEqual(["ANTHROPIC_API_KEY"]);
    expect([...parsed.egressProxy.allow].sort()).toEqual(["api.anthropic.com:443", "api.github.com:443", "github.com:443"]);
  });

  it("proxyens gateway-adresse er innenfor jobbnettverkets subnett, og proxy-URL-en i runner-seksjonen peker på nøyaktig den", async () => {
    const example = JSON.parse(await read("infra/job-runner/job-runner.example.json"));
    expect(example.runner.egress_proxy_url).toBe(`http://${example.egress_proxy.listen_host}:${example.egress_proxy.listen_port}`);
    expect(example.egress_proxy.listen_host).toBe("172.30.77.1");
    expect(example.egress_proxy.allowed_client_cidrs).toEqual(["172.30.77.0/24"]);
  });

  it("ingen hemmeligheter i eksempelfilen: kun stier til tokenfiler", async () => {
    const text = await read("infra/job-runner/job-runner.example.json");
    expect(text).not.toMatch(/ghp_|github_pat_|sk-ant|Bearer |password/i);
    const example = JSON.parse(text);
    for (const entry of Object.values(example.runner.git_credentials)) expect(entry.token_file).toMatch(/^\/etc\/jarvis\/git-token-[a-z0-9-]+$/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Skript som kjøres for ekte mot falske verktøy
// ---------------------------------------------------------------------------------------------------------------------------------------

const NEEDED = ["sh", "bash", "dirname", "cat", "grep", "sed", "awk", "cut", "head", "tail", "tr", "env", "date", "mktemp", "rm", "install", "find", "chmod", "chown", "stat", "mkdir", "cp", "ls", "uname", "sleep", "sort", "wc"];
let toolbox = "";
beforeAll(async () => {
  // En PATH som bare har systemverktøyene scriptene trenger + node (symlinket) - UTEN docker/iptables/git, slik at «mangler verktøy» kan testes.
  toolbox = await mkdtemp(join(tmpdir(), "wpc1-toolbox-"));
  for (const name of NEEDED) {
    const real = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map((d) => join(d, name)).find((p) => existsSync(p));
    if (real) await symlink(real, join(toolbox, name));
  }
  await symlink(process.execPath, join(toolbox, "node"));
});

/** Lager en isolert testverden: falsk bin med valgt sett verktøy + tilstandskatalog. */
async function makeWorld({ tools = ["docker", "iptables", "iptables-restore"], uid = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wpc1-infra-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  await mkdir(bin);
  await mkdir(state);
  for (const name of tools) {
    await writeFile(join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_TOOL}' ${name} "$@"\n`, { mode: 0o755 });
  }
  await writeFile(join(bin, "id"), `#!/bin/sh\nif [ "$1" = "-u" ]; then echo ${uid}; else exec /usr/bin/id "$@"; fi\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${toolbox}`, HOME: root, LANG: "C.UTF-8", FAKE_STATE: state };
  const run = (script, args = [], extraEnv = {}) =>
    spawnSync(BASH, [script, ...args], { encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 60_000 });
  const calls = async () => (existsSync(join(state, "calls.log")) ? (await readFile(join(state, "calls.log"), "utf8")).split("\n").filter(Boolean) : []);
  const iptables = async () => JSON.parse(await readFile(join(state, "iptables.json"), "utf8"));
  return { root, bin, state, env, run, calls, iptables };
}

async function writeConfig(root, overrides = {}) {
  const example = JSON.parse(await read("infra/job-runner/job-runner.example.json"));
  const config = {
    ...example,
    runner: { ...example.runner, ...(overrides.runner ?? {}) },
    egress_proxy: { ...example.egress_proxy, ...(overrides.egress_proxy ?? {}) }
  };
  const path = join(root, "job-runner.json");
  await writeFile(path, JSON.stringify(config));
  return path;
}

describe("E: setup-network.sh (kjørt for ekte mot falsk docker/iptables)", () => {
  const SCRIPT = join(INFRA, "setup-network.sh");
  const CREATE = "docker network create --driver bridge --internal --subnet 172.30.77.0/24 --gateway 172.30.77.1 --opt com.docker.network.bridge.name=br-jarvis-jobs --opt com.docker.network.bridge.enable_icc=false jarvis-jobs";

  it("første kjøring: oppretter et INTERNT nettverk uten kommunikasjon mellom containere, og en INPUT-kjede som slipper KUN tcp gateway:port inn", async () => {
    const w = await makeWorld();
    const config = await writeConfig(w.root);
    const r = w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("jobbnettverket er klart");
    const calls = await w.calls();
    expect(calls.filter((c) => c.startsWith("docker network create"))).toEqual([CREATE]);
    expect(calls).toContain("iptables-restore --noflush");
    const restore = await readFile(join(w.state, "restore-input.txt"), "utf8");
    expect(restore.split("\n").filter(Boolean)).toEqual([
      "*filter",
      ":JARVIS-JOBS-IN - [0:0]",
      "-A JARVIS-JOBS-IN -p tcp -d 172.30.77.1 --dport 3128 -j ACCEPT",
      "-A JARVIS-JOBS-IN -p tcp -j REJECT --reject-with tcp-reset",
      "-A JARVIS-JOBS-IN -j REJECT --reject-with icmp-port-unreachable",
      "COMMIT"
    ]);
    const state = await w.iptables();
    expect(state.input).toEqual(["-A INPUT -i br-jarvis-jobs -j JARVIS-JOBS-IN"]);
    // kontroll av at verifiseringen mot «iptables -S» ser det samme som restore laget (modellen er konsistent)
    expect(state.chains["JARVIS-JOBS-IN"][0]).toBe("-A JARVIS-JOBS-IN -d 172.30.77.1/32 -p tcp -m tcp --dport 3128 -j ACCEPT");
  });

  it("idempotent: andre kjøring oppretter ikke nettverket på nytt og lager ingen dupliserte INPUT-hopp", async () => {
    const w = await makeWorld();
    const config = await writeConfig(w.root);
    expect(w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config }).status).toBe(0);
    const second = w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config });
    expect(second.status, second.stderr + second.stdout).toBe(0);
    const calls = await w.calls();
    expect(calls.filter((c) => c.startsWith("docker network create"))).toHaveLength(1);
    expect((await w.iptables()).input).toEqual(["-A INPUT -i br-jarvis-jobs -j JARVIS-JOBS-IN"]);
  });

  it("--check endrer ALDRI noe: på en ren verten feiler den (exit 1) uten å opprette nettverk, regler eller hopp", async () => {
    const w = await makeWorld();
    const config = await writeConfig(w.root);
    const r = w.run(SCRIPT, ["--check"], { JARVIS_JOB_RUNNER_CONFIG: config });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("finnes ikke");
    const calls = await w.calls();
    expect(calls.some((c) => c.startsWith("docker network create"))).toBe(false);
    expect(calls.some((c) => c.startsWith("iptables-restore"))).toBe(false);
    expect(calls.some((c) => / -I INPUT| -D INPUT/.test(c))).toBe(false);
  });

  it("--check etter oppsett: exit 0 og kun lesekall", async () => {
    const w = await makeWorld();
    const config = await writeConfig(w.root);
    expect(w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config }).status).toBe(0);
    const before = (await w.calls()).length;
    const r = w.run(SCRIPT, ["--check"], { JARVIS_JOB_RUNNER_CONFIG: config });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const added = (await w.calls()).slice(before);
    expect(added.length).toBeGreaterThan(0);
    for (const call of added) expect(call, call).toMatch(/^(docker network inspect|iptables -w -(C|S) )/);
  });

  it("et eksisterende nettverk som IKKE er --internal avvises (exit 1) - scriptet sletter eller omskaper aldri et nettverk selv", async () => {
    const w = await makeWorld();
    const config = await writeConfig(w.root);
    await writeFile(join(w.state, "network.json"), JSON.stringify({
      name: "jarvis-jobs", id: "ab".repeat(32), internal: false, driver: "bridge", subnet: "172.30.77.0/24", gateway: "172.30.77.1", icc: "false", bridge: "br-jarvis-jobs"
    }));
    const r = w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("IKKE --internal");
    const calls = await w.calls();
    expect(calls.some((c) => c.startsWith("docker network create") || c.startsWith("docker network rm"))).toBe(false);
  });

  it("enable_icc ikke false eller feil subnett/gateway på et eksisterende nettverk: exit 1", async () => {
    for (const patch of [{ icc: "true" }, { icc: "" }, { subnet: "10.9.0.0/24", gateway: "10.9.0.1" }]) {
      const w = await makeWorld();
      const config = await writeConfig(w.root);
      await writeFile(join(w.state, "network.json"), JSON.stringify({
        name: "jarvis-jobs", id: "cd".repeat(32), internal: true, driver: "bridge", subnet: "172.30.77.0/24", gateway: "172.30.77.1", icc: "false", bridge: "br-jarvis-jobs", ...patch
      }));
      const r = w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config });
      expect(r.status, JSON.stringify(patch)).toBe(1);
    }
  });

  it("et generelt ACCEPT foran hoppet: --check feiler; vanlig kjøring flytter hoppet først uten å etterlate duplikater", async () => {
    const w = await makeWorld();
    const config = await writeConfig(w.root);
    await writeFile(join(w.state, "network.json"), JSON.stringify({
      name: "jarvis-jobs", id: "ef".repeat(32), internal: true, driver: "bridge", subnet: "172.30.77.0/24", gateway: "172.30.77.1", icc: "false", bridge: "br-jarvis-jobs"
    }));
    // verten har allerede et bredt ACCEPT FØRST, en ufarlig lo-ACCEPT, og hoppet ligger bak dem (og står to ganger)
    await writeFile(join(w.state, "iptables.json"), JSON.stringify({
      input: ["-A INPUT -i lo -j ACCEPT", "-A INPUT -j ACCEPT", "-A INPUT -i br-jarvis-jobs -j JARVIS-JOBS-IN", "-A INPUT -p tcp --dport 22 -j ACCEPT", "-A INPUT -i br-jarvis-jobs -j JARVIS-JOBS-IN"],
      chains: {}
    }));
    const check = w.run(SCRIPT, ["--check"], { JARVIS_JOB_RUNNER_CONFIG: config });
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/finnes 2 ganger|IKKE foran generelle ACCEPT|avvis-regel mangler|regelen som tillater/);
    const fix = w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config });
    expect(fix.status, fix.stderr + fix.stdout).toBe(0);
    expect((await w.iptables()).input).toEqual([
      "-A INPUT -i br-jarvis-jobs -j JARVIS-JOBS-IN", "-A INPUT -i lo -j ACCEPT", "-A INPUT -j ACCEPT", "-A INPUT -p tcp --dport 22 -j ACCEPT"
    ]);
  });

  it("en ACCEPT bundet til ett bestemt annet grensesnitt (lo) foran hoppet er ufarlig - og et wildcard-grensesnitt (br+) er IKKE det", async () => {
    const seed = async (rules) => {
      const w = await makeWorld();
      const config = await writeConfig(w.root);
      expect(w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config }).status).toBe(0);
      const state = await w.iptables();
      state.input = [...rules, ...state.input];
      await writeFile(join(w.state, "iptables.json"), JSON.stringify(state));
      return w.run(SCRIPT, ["--check"], { JARVIS_JOB_RUNNER_CONFIG: config });
    };
    expect((await seed(["-A INPUT -i lo -j ACCEPT"])).status).toBe(0);
    expect((await seed(["-A INPUT -i br+ -j ACCEPT"])).status).toBe(1);
    expect((await seed(["-A INPUT ! -i lo -j ACCEPT"])).status).toBe(1);
  });

  it("ugyldig eller farlig konfig avvises FØR noe røres (exit 2): wildcard-adresse, host-nettverk, manglende subnett, ugyldig subnett", async () => {
    const cases = [
      { egress_proxy: { listen_host: "0.0.0.0" } },
      { runner: { network: "host" } },
      { runner: { network: "bridge" } },
      { runner: { network: "A;rm" } },
      { egress_proxy: { allowed_client_cidrs: [] } },
      { egress_proxy: { allowed_client_cidrs: ["172.30.77.0"] } },
      { egress_proxy: { listen_host: "ikke-en-ip" } },
      { egress_proxy: { listen_port: "3128;x" } }
    ];
    for (const overrides of cases) {
      const w = await makeWorld();
      const config = await writeConfig(w.root, overrides);
      const r = w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config });
      expect(r.status, JSON.stringify(overrides)).toBe(2);
      const calls = await w.calls();
      expect(calls.some((c) => c.startsWith("docker network create") || c.startsWith("iptables-restore")), JSON.stringify(overrides)).toBe(false);
    }
  });

  it("krever root, kjente argumenter, tilgjengelig docker/iptables og lesbar konfig - og sier hva som mangler", async () => {
    const asUser = await makeWorld({ uid: 1000 });
    const config = await writeConfig(asUser.root);
    const notRoot = asUser.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config });
    expect(notRoot.status).toBe(2);
    expect(notRoot.stderr).toContain("må kjøres som root");

    const w = await makeWorld();
    const wConfig = await writeConfig(w.root);
    expect(w.run(SCRIPT, ["--rm-rf"], { JARVIS_JOB_RUNNER_CONFIG: wConfig }).status).toBe(2);
    expect(w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: join(w.root, "finnes-ikke.json") }).status).toBe(2);

    const noIptables = await makeWorld({ tools: ["docker"] });
    const c2 = await writeConfig(noIptables.root);
    const missing = noIptables.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: c2 });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("iptables finnes ikke");
    expect(missing.stderr).toContain("nft");
    expect((await noIptables.calls()).some((c) => c.startsWith("docker network create"))).toBe(false);

    const noDocker = await makeWorld({ tools: ["iptables", "iptables-restore"] });
    const c3 = await writeConfig(noDocker.root);
    const r3 = noDocker.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: c3 });
    expect(r3.status).toBe(2);
    expect(r3.stderr).toContain("docker finnes ikke");
  });

  it("regelteksten er gyldig syntaks for ekte iptables-restore (--test): root får exit 0; uten root stopper den først ved COMMIT (alle regellinjer er parset)", async () => {
    const w = await makeWorld();
    const config = await writeConfig(w.root);
    expect(w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: config }).status).toBe(0);
    const text = await readFile(join(w.state, "restore-input.txt"), "utf8");
    const bin = ["/usr/sbin/iptables-restore", "/sbin/iptables-restore", "/usr/bin/iptables-restore"].find((p) => existsSync(p));
    if (!bin) return; // verktøyet finnes ikke her
    const run = (input) => spawnSync(bin, ["--test", "--noflush"], { input, encoding: "utf8", timeout: 30_000 });
    const lastLine = text.split("\n").filter(Boolean).length; // COMMIT er siste linje
    /** «ok» = godtatt (root) eller kun avvist av kjernen ved COMMIT (ikke root); «syntax» = parse-feil på en regellinje; «unknown» = ukjent feilformat (hoppes over). */
    const verdict = (r) => {
      if (r.error) return "unknown";
      if (r.status === 0) return "ok";
      const err = r.stderr ?? "";
      const atCommit = new RegExp(`line ${lastLine} failed: Permission denied`).test(err);
      if (atCommit) return "ok";
      if (/Error occurred at line: \d+|invalid|unknown option|bad argument|unexpected/i.test(err)) return "syntax";
      return "unknown";
    };
    const good = verdict(run(text));
    if (good === "unknown") return; // ikke mulig å tolke her (annen iptables-variant/miljø)
    expect(good, run(text).stderr).toBe("ok");
    // negativ kontroll: en ødelagt regel gir parse-feil (probeen er følsom for syntaksfeil)
    expect(verdict(run(text.replace("--dport 3128", "--dport")))).toBe("syntax");
  });

  it("kjører mot eksempelkonfigen uten endringer (nettverks-/proxy-verdiene er konsistente med det scriptet forventer)", async () => {
    const w = await makeWorld();
    const r = w.run(SCRIPT, [], { JARVIS_JOB_RUNNER_CONFIG: join(INFRA, "job-runner.example.json") });
    expect(r.status, r.stderr + r.stdout).toBe(0);
  });
});

describe("F: build-job-image.sh (kjørt for ekte mot falsk docker)", () => {
  const SCRIPT = join(INFRA, "build-job-image.sh");
  const IMAGE_ID = `sha256:${"b".repeat(64)}`;

  async function fakeDocker(world, { id = IMAGE_ID, failRun = false } = {}) {
    await writeFile(join(world.bin, "docker"), [
      "#!/bin/sh",
      `echo "$@" >> '${join(world.state, "docker.log")}'`,
      'case "$1" in',
      "  build) exit 0 ;;",
      `  image) echo '${id}' ; exit 0 ;;`,
      `  run) ${failRun ? "exit 1" : "exit 0"} ;;`,
      "esac",
      "exit 3",
      ""
    ].join("\n"), { mode: 0o755 });
  }

  it("bygger fra Dockerfile.job med lockfil-konteksten, kjører selvtest med SAMME begrensninger som runneren, og skriver ut image-ID-en", async () => {
    const w = await makeWorld({ tools: [] });
    await fakeDocker(w);
    const r = w.run(SCRIPT, ["jarvis-job:test"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain(`image-ID:   ${IMAGE_ID}`);
    const log = (await readFile(join(w.state, "docker.log"), "utf8")).split("\n").filter(Boolean);
    const build = log.find((l) => l.startsWith("build"));
    expect(build).toContain(`--file ${INFRA}/Dockerfile.job`);
    expect(build).toContain(`--tag jarvis-job:test ${INFRA}/claude-code`);
    const selftest = log.find((l) => l.startsWith("run"));
    for (const flag of ["--rm", "--pull never", "--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges:true", "--user 10001:10001"]) {
      expect(selftest, flag).toContain(flag);
    }
    expect(selftest).toContain(IMAGE_ID); // kjører selve ID-en, ikke en flytende tagg
  });

  it("avviser ugyldig tagg (exit 2), uventet image-ID (exit 1) og feilende selvtest (exit != 0) - uten å anbefale et image", async () => {
    const w = await makeWorld({ tools: [] });
    await fakeDocker(w);
    expect(w.run(SCRIPT, ["bad tag;rm -rf /"]).status).toBe(2);
    expect((await readFile(join(w.state, "docker.log"), "utf8").catch(() => "")).includes("build")).toBe(false);

    await fakeDocker(w, { id: "sha256:kort" });
    const bad = w.run(SCRIPT, ["jarvis-job:test"]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).not.toContain("BYGGET OK");

    await fakeDocker(w, { failRun: true });
    const failing = w.run(SCRIPT, ["jarvis-job:test"]);
    expect(failing.status).not.toBe(0);
    expect(failing.stdout).not.toContain("BYGGET OK");
  });

  it("uten docker på PATH: tydelig melding og exit 2", async () => {
    const w = await makeWorld({ tools: [] });
    const r = w.run(SCRIPT, ["jarvis-job:test"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("docker finnes ikke");
  });
});

describe("G: install-host.sh --stage (ekte kjøring i en midlertidig prefiks-katalog; ingen root, ingen brukere, ingen systemctl)", () => {
  const SCRIPT = join(INFRA, "install-host.sh");
  let stageCount = 0;

  async function stage(prefix) {
    const w = await makeWorld({ tools: [] });
    const target = prefix ?? join(w.root, `prefix-${++stageCount}`);
    const r = w.run(SCRIPT, ["--stage", "--prefix", target]);
    return { w, target, r };
  }

  it("installerer root-layouten: kode (uten test/), delt container-spesifikasjon, setup-network.sh (kjørbar), enhetene og eksempelkonfigen", async () => {
    const { target, r } = await stage();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const code = join(target, "opt/jarvis-job-runner");
    for (const rel of [
      "ops/job-runner/server.mjs", "ops/job-runner/egress-proxy.mjs", "ops/job-runner/credential-helper.mjs",
      "ops/job-runner/lib/api.mjs", "ops/job-runner/lib/config.mjs", "ops/job-runner/lib/docker.mjs", "ops/job-runner/lib/git.mjs",
      "ops/job-runner/lib/jobs.mjs", "ops/job-runner/lib/spec.mjs", "ops/job-runner/lib/credentials.mjs",
      "modules/tasks/src/job-container-spec.mjs", "infra/job-runner/setup-network.sh"
    ]) {
      expect(existsSync(join(code, rel)), rel).toBe(true);
    }
    expect((await stat(join(code, "infra/job-runner/setup-network.sh"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(code, "ops/job-runner/server.mjs"))).mode & 0o777).toBe(0o644); // ikke skrivbar for tjenestebrukeren
    expect(existsSync(join(code, "ops/job-runner/test"))).toBe(false);
    const all = (await readdir(join(code, "ops/job-runner"), { recursive: true })).map(String);
    expect(all.filter((f) => /\.test\.mjs$|acceptance|fake-|harness/.test(f))).toEqual([]);
    for (const unit of ["jarvis-job-runner.service", "jarvis-egress-proxy.service"]) {
      expect(await readFile(join(target, "etc/systemd/system", unit), "utf8")).toBe(await readFile(join(INFRA, unit), "utf8"));
    }
    expect(existsSync(join(target, "etc/jarvis/job-runner.example.json"))).toBe(true);
    // state-katalogen (0700) og den PERSISTENTE socket-katalogen (0750) som worker monterer
    const state = join(target, "var/lib/jarvis-job-runner");
    expect((await stat(state)).mode & 0o777).toBe(0o700);
    expect((await stat(join(state, "sock"))).mode & 0o777).toBe(0o750);
  });

  it("ekte installasjon (ikke --stage) nekter å fortsette uten /usr/bin/prlimit (A-F3: samme sti som runner.prlimit_bin-standarden)", async () => {
    const text = await readFile(SCRIPT, "utf8");
    const real = text.slice(text.indexOf('if [ "$STAGE" = "0" ]; then\n  need docker'), text.indexOf("# --- brukere og grupper"));
    expect(real).toContain("[ -x /usr/bin/prlimit ] ||");
    expect(real).toMatch(/prlimit mangler[^\n]*>&2; exit 2/);
    const config = await readFile(join(ROOT, "ops/job-runner/lib/config.mjs"), "utf8");
    expect(config).toMatch(/absPathField\(r, "prlimit_bin", "runner", "\/usr\/bin\/prlimit"\)/);
  });

  it("ekte installasjon (ikke --stage) nekter å fortsette uten GNU coreutils: runneren rydder med /bin/rm -rf --one-file-system og /bin/chmod -R", async () => {
    const text = await readFile(SCRIPT, "utf8");
    const real = text.slice(text.indexOf('if [ "$STAGE" = "0" ]; then\n  need docker'), text.indexOf("# --- brukere og grupper"));
    expect(real).toContain("for tool in rm chmod");
    expect(real).toContain('"/bin/$tool" --version');
    expect(real).toContain("GNU coreutils");
    // og stien/flaggene koden faktisk bruker er de samme som skriptet kontrollerer
    const fsutil = await readFile(join(ROOT, "ops/job-runner/lib/fsutil.mjs"), "utf8");
    expect(fsutil).toContain('RM_BIN = "/bin/rm"');
    expect(fsutil).toContain('CHMOD_BIN = "/bin/chmod"');
    expect(fsutil).toContain('"--one-file-system"');
  });

  it("state-/socket-katalogen slettes ALDRI av en ny installasjon: samme inode og urørt innhold (en bind-mount i worker forblir gyldig)", async () => {
    const { target, w } = await stage();
    const sock = join(target, "var/lib/jarvis-job-runner/sock");
    const before = await stat(sock);
    await writeFile(join(sock, "runner.sock"), "plassholder for en socket");
    await mkdir(join(target, "var/lib/jarvis-job-runner/jobs"), { recursive: true });
    await writeFile(join(target, "var/lib/jarvis-job-runner/jobs/pagaende"), "en jobb");
    const again = w.run(SCRIPT, ["--stage", "--prefix", target]);
    expect(again.status, again.stderr).toBe(0);
    const after = await stat(sock);
    expect({ ino: after.ino, dev: after.dev, mode: after.mode & 0o777 }).toEqual({ ino: before.ino, dev: before.dev, mode: 0o750 });
    expect(await readFile(join(sock, "runner.sock"), "utf8")).toBe("plassholder for en socket");
    expect(await readFile(join(target, "var/lib/jarvis-job-runner/jobs/pagaende"), "utf8")).toBe("en jobb");
  });

  it("bearer-tokenet genereres kun hvis det mangler (0640, 64 hex-tegn) og skrives aldri ut; en ny kjøring beholder det", async () => {
    const { target, r, w } = await stage();
    expect(r.status).toBe(0);
    const tokenPath = join(target, "etc/jarvis/job-runner.token");
    const token = await readFile(tokenPath, "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}\n$/);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o640);
    expect(r.stdout).not.toContain(token.trim());
    expect(r.stderr).not.toContain(token.trim());
    const again = w.run(SCRIPT, ["--stage", "--prefix", target]);
    expect(again.status).toBe(0);
    expect(await readFile(tokenPath, "utf8")).toBe(token);
    expect(again.stdout).toContain("beholder eksisterende");
  });

  it("eierens konfig røres ALDRI: eksisterende job-runner.json forblir byte-identisk, og stale kodefiler fra en eldre versjon fjernes", async () => {
    const { target, w } = await stage();
    const config = join(target, "etc/jarvis/job-runner.json");
    await writeFile(config, '{"eier":"sin egen konfig"}\n');
    const pat = join(target, "etc/jarvis/git-token-sandbox");
    await writeFile(pat, "eierens-pat-fil\n");
    const stale = join(target, "opt/jarvis-job-runner/ops/job-runner/lib/gammel.mjs");
    await writeFile(stale, "// fra en eldre versjon\n");
    const again = w.run(SCRIPT, ["--stage", "--prefix", target]);
    expect(again.status, again.stderr).toBe(0);
    expect(await readFile(config, "utf8")).toBe('{"eier":"sin egen konfig"}\n');
    expect(await readFile(pat, "utf8")).toBe("eierens-pat-fil\n");
    expect(existsSync(stale)).toBe(false);
    expect(again.stdout).toContain("beholder eksisterende");
  });

  it("MANGLER-meldingen for ekte konfig vises når den ikke finnes (installasjonen lager aldri en konfig selv)", async () => {
    const { target, r } = await stage();
    expect(r.stdout).toContain("MANGLER");
    expect(existsSync(join(target, "etc/jarvis/job-runner.json"))).toBe(false);
  });

  it("den installerte koden er KOMPLETT: server.mjs og egress-proxy.mjs importerer uten ERR_MODULE_NOT_FOUND og feiler lukket på manglende konfig", async () => {
    const { target } = await stage();
    const code = join(target, "opt/jarvis-job-runner/ops/job-runner");
    for (const entry of ["server.mjs", "egress-proxy.mjs"]) {
      const r = spawnSync(process.execPath, [join(code, entry)], {
        encoding: "utf8", env: { PATH: process.env["PATH"], JARVIS_JOB_RUNNER_CONFIG: join(target, "finnes-ikke.json") }, timeout: 30_000
      });
      expect(r.status, entry).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`, entry).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError/);
      expect(`${r.stdout}${r.stderr}`, entry).toMatch(/config/i);
    }
    // credential-helperen kjører også fra den installerte layouten
    const helper = spawnSync(process.execPath, [join(code, "credential-helper.mjs"), "https", "github.com", "owner/repo", "get"], {
      input: "protocol=https\nhost=github.com\npath=owner/repo.git\n\n", encoding: "utf8", env: { PATH: process.env["PATH"], JARVIS_GIT_CREDENTIAL_TOKEN: "x".repeat(20) }
    });
    expect(helper.stdout).toContain("username=x-access-token");
  });

  it("kjører ALDRI utenfor prefiks i --stage: ingen sti under / endres (kun PREFIX-baserte mål), og uttrykkelig ugyldig bruk avvises", async () => {
    const text = await readFile(SCRIPT, "utf8");
    expect(text).toMatch(/^CODE="\$PREFIX\/opt\/jarvis-job-runner"$/m);
    expect(text).toMatch(/^ETC="\$PREFIX\/etc\/jarvis"$/m);
    expect(text).toMatch(/^UNITS="\$PREFIX\/etc\/systemd\/system"$/m);
    const w = await makeWorld({ tools: [] });
    expect(w.run(SCRIPT, ["--stage"]).status).toBe(2); // --stage uten --prefix
    expect(w.run(SCRIPT, ["--prefix", join(w.root, "x")]).status).toBe(2); // --prefix uten --stage
    expect(w.run(SCRIPT, ["--bogus"]).status).toBe(2);
    expect(existsSync(join(w.root, "x"))).toBe(false);
    const user = await makeWorld({ tools: [], uid: 1000 }); // id-skallet melder uid 1000: en vanlig installasjon uten --stage krever root
    const notRoot = user.run(SCRIPT, []);
    expect(notRoot.status).toBe(2);
    expect(notRoot.stderr).toContain("må kjøres som root");
  });
});

describe("H: alle skript er syntaktisk gyldige og har streng feilhåndtering", () => {
  const scripts = ["infra/job-runner/install-host.sh", "infra/job-runner/setup-network.sh", "infra/job-runner/build-job-image.sh", "ops/job-runner/acceptance.sh"];
  it("bash -n er ren for alle fire", () => {
    for (const rel of scripts) {
      const r = spawnSync(BASH, ["-n", join(ROOT, rel)], { encoding: "utf8" });
      expect(r.status, `${rel}: ${r.stderr}`).toBe(0);
    }
  });
  it("installasjons-/nettverks-/bygg-skriptene bruker set -euo pipefail; akseptansescriptet bruker set -uo pipefail (samler FAIL i stedet for å avbryte)", async () => {
    for (const rel of scripts.slice(0, 3)) expect(await read(rel), rel).toMatch(/^set -euo pipefail$/m);
    expect(await read(scripts[3])).toMatch(/^set -uo pipefail$/m);
  });
  it("ingen skript inneholder innebygde hemmeligheter (token-verdier, PAT-prefikser, API-nøkler)", async () => {
    for (const rel of scripts) expect(await read(rel), rel).not.toMatch(/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9-]{20,}/);
  });
});
