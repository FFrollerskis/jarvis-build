import { chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFile, validateConfig } from "../lib/config.mjs";
import { ConfigError } from "../lib/errors.mjs";
import { makeTempDir } from "./support/tmp.mjs";

/**
 * WP-C1: konfigfilen EIES AV VERTSADMIN og kan ALDRI overstyres via API-et. Alt som ikke er eksplisitt tillatt avvises -
 * ukjente nøkler, test-flagg, løse nettverk, jokertegn-adresser, uforankrede stier.
 */

const IMAGE = `sha256:${"a".repeat(64)}`;
const runner = () => ({
  token_file: "/etc/jarvis/job-runner.token",
  image: IMAGE,
  network: "jarvis-jobs",
  egress_proxy_url: "http://172.30.77.1:3128",
  allowed_repos: ["tsworkflow/jarvisbuild"],
  git_credentials: { "tsworkflow/jarvisbuild": { token_file: "/etc/jarvis/git-token-jarvisbuild" } }
});
const proxy = () => ({ listen_host: "172.30.77.1", allowed_client_cidrs: ["172.30.77.0/24"] });
const parse = (r, p) => validateConfig({ version: 1, ...(r ? { runner: r } : {}), ...(p ? { egress_proxy: p } : {}) }, { require: [] });
const code = (fn) => {
  try { fn(); } catch (e) { return e instanceof ConfigError ? `${e.code}:${e.message.split(":").slice(1).join(":")}` : `other:${e}`; }
  return "no_error";
};

describe("A: gyldig konfig og standardverdier", () => {
  it("minimal runner-konfig får trygge standardverdier", () => {
    const { runner: r } = parse(runner());
    expect(r.socketPath).toBe("/var/lib/jarvis-job-runner/sock/runner.sock");
    expect(r.baseDir).toBe("/var/lib/jarvis-job-runner/jobs");
    expect(r.maxConcurrentJobs).toBe(2);
    expect(r.maxJobLifetimeS).toBe(3600);
    expect(r.branchPrefix).toBe("jarvis/");
    expect(r.policy).toMatchObject({ user: "10001:10001", memory: "1g", cpus: "1.0", pidsLimit: 256, pull: "never" });
    expect([...r.publish.denyPaths]).toEqual([".github/", ".gitmodules", ".gitattributes", ".lfsconfig"]); // A-F1: .lfsconfig er med (LFS-url mot en fremmed server)
    expect(r.publish.maxCommits).toBe(20);
    expect(r.envAllow).toEqual(["ANTHROPIC_API_KEY"]); // standard: KUN Anthropic-nøkkelen worker leverer til Claude Code
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.envAllow)).toBe(true);
  });

  it("B-M3: minimal proxy-konfig har standard allowlist KUN api.anthropic.com:443 (github.com/api.github.com må eieren legge til eksplisitt: klone/push skjer på verten)", () => {
    const { egressProxy: p } = parse(undefined, proxy());
    expect([...p.allow]).toEqual(["api.anthropic.com:443"]);
    expect(p.listenPort).toBe(3128);
  });

  it("require-listen styrer hvilken seksjon som er påkrevd", () => {
    expect(code(() => validateConfig({ version: 1, egress_proxy: proxy() }, { require: ["runner"] }))).toContain("config_invalid:runner:section_required");
    expect(code(() => validateConfig({ version: 1, runner: runner() }, { require: ["egress_proxy"] }))).toContain("egress_proxy:section_required");
  });
});

describe("B: ukjente nøkler og test-flagg avvises (kan ikke settes fra filen)", () => {
  it("ukjente nøkler på hvert nivå", () => {
    expect(code(() => parse({ ...runner(), surprise: 1 }))).toContain("config_unknown_key:runner.surprise");
    expect(code(() => parse(runner(), { ...proxy(), surprise: 1 }))).toContain("egress_proxy.surprise");
    expect(code(() => validateConfig({ version: 1, runner: runner(), extra: {} }, { require: [] }))).toContain("config.extra");
    expect(code(() => parse({ ...runner(), publish: { max_commits: 3, nope: 1 } }))).toContain("runner.publish.nope");
    expect(code(() => parse({ ...runner(), git_identity: { name: "x", nope: 1 } }))).toContain("runner.git_identity.nope");
    expect(code(() => parse({ ...runner(), git_credentials: { "tsworkflow/jarvisbuild": { token_file: "/etc/x", nope: 1 } } }))).toContain("nope");
  });

  it("test-flagg finnes IKKE i skjemaet: file://-remote, hopp over uid-sjekk, ikke-root-eier, falsk remote", () => {
    for (const key of ["allow_file_protocol", "allow_file", "skip_uid_check", "allow_any_owner", "remote", "test_overrides", "testOverrides", "insecure", "debug", "allow_unpinned_image", "allowUnpinnedImage", "privileged", "mounts", "extra_args", "docker_args"]) {
      expect(code(() => parse({ ...runner(), [key]: true })), key).toContain("config_unknown_key");
    }
  });

  it("__proto__ som nøkkel (prototype pollution) avvises som ukjent nøkkel", () => {
    const poisoned = JSON.parse(`{"version":1,"runner":${JSON.stringify(runner())},"__proto__":{"polluted":true}}`);
    expect(code(() => validateConfig(poisoned, { require: [] }))).toContain("config_unknown_key");
    expect(({}).polluted).toBeUndefined();
  });

  it("version må være 1; roten må være et objekt", () => {
    expect(code(() => validateConfig({ version: 2, runner: runner() }, { require: [] }))).toContain("version");
    expect(code(() => validateConfig([], { require: [] }))).toContain("config_invalid");
    expect(code(() => validateConfig(null, { require: [] }))).toContain("config_invalid");
  });
});

describe("C: runner-policy valideres fail-closed", () => {
  it("image må være digest-pinnet eller lokalt image-ID", () => {
    for (const image of ["node:22", "jarvis-job:latest", "sha256:abc", ""]) {
      expect(code(() => parse({ ...runner(), image })), image).toContain("config_invalid");
    }
    expect(code(() => parse({ ...runner(), image: `jarvis-job@sha256:${"c".repeat(64)}` }))).toBe("no_error");
  });

  it("den nullede plassholder-image-ID-en fra eksempelkonfigen avvises (en uendret kopi kan aldri starte tjenesten)", () => {
    for (const image of [`sha256:${"0".repeat(64)}`, `jarvis-job@sha256:${"0".repeat(64)}`]) {
      expect(code(() => parse({ ...runner(), image })), image).toBe("config_invalid:runner.image:placeholder_not_replaced");
    }
  });

  it("nettverk må være dedikert (aldri host/bridge/none/default)", () => {
    for (const network of ["host", "bridge", "none", "default", "A B"]) expect(code(() => parse({ ...runner(), network })), network).toContain("config_invalid");
  });

  it("proxy-URL: kun http(s), ingen brukerinfo, og vert må være en IP-literal (jobbnettet har ingen DNS)", () => {
    for (const egress_proxy_url of ["ftp://172.30.77.1:3128", "http://u:p@172.30.77.1:3128", "http://egress-proxy:3128", "nonsense"]) {
      expect(code(() => parse({ ...runner(), egress_proxy_url })), egress_proxy_url).toContain("config_invalid");
    }
  });

  it("bruker må være ikke-root numerisk uid:gid; ressursverdier valideres", () => {
    for (const user of ["0:0", "root", "0", "1000"]) expect(code(() => parse({ ...runner(), user })), user).toContain("config_invalid");
    for (const memory of ["1g --privileged", "abc", "0"]) expect(code(() => parse({ ...runner(), memory })), memory).toContain("config_invalid");
    expect(code(() => parse({ ...runner(), pids_limit: 1 }))).toContain("config_invalid");
    expect(code(() => parse({ ...runner(), max_concurrent_jobs: 0 }))).toContain("config_invalid");
    expect(code(() => parse({ ...runner(), max_concurrent_jobs: 17 }))).toContain("config_invalid");
    expect(code(() => parse({ ...runner(), default_exec_timeout_ms: 900_001, max_exec_timeout_ms: 900_000 }))).toContain("above_max");
  });

  it("stier: absolutte og trygge (ingen .., //, mellomrom, komma); base_dir følger bind-mount-tegnsettet", () => {
    for (const token_file of ["relative", "/etc/../x", "/etc//x", "/etc/a b", ""]) expect(code(() => parse({ ...runner(), token_file })), token_file).toContain("config_invalid");
    expect(code(() => parse({ ...runner(), base_dir: "/var/lib/a,source=/" }))).toContain("config_invalid");
    expect(code(() => parse({ ...runner(), base_dir: "/var/lib/a@b" }))).toContain("base_dir");
  });

  it("repo-allowlist: ikke tom, kun lavere-case owner/repo, og hvert repo MÅ ha credential (og omvendt)", () => {
    expect(code(() => parse({ ...runner(), allowed_repos: [] }))).toContain("empty_means_nothing_allowed");
    for (const bad of ["Owner/Repo", "owner", "owner/repo/extra", "-x/y", "owner/", "/repo", "o/../x"]) {
      expect(code(() => parse({ ...runner(), allowed_repos: [bad] })), bad).toContain("config_invalid");
    }
    expect(code(() => parse({ ...runner(), git_credentials: {} }))).toContain("missing_credential_for_allowed_repo");
    expect(code(() => parse({ ...runner(), git_credentials: { ...runner().git_credentials, "other/repo": { token_file: "/etc/x" } } }))).toContain("not_in_allowed_repos");
  });

  it("git_credentials[repo].source: `file` (standard) eller `request`; nøyaktig ÉN kilde per repo, aldri en stille standard eller fallback", () => {
    const withCreds = (git_credentials, allowed_repos = Object.keys(git_credentials)) => ({ ...runner(), allowed_repos, git_credentials });
    // standard: token_file alene = source file (uendret oppførsel for eksisterende konfiger)
    const std = parse(runner()).runner.gitCredentials["tsworkflow/jarvisbuild"];
    expect(std).toEqual({ source: "file", tokenFile: "/etc/jarvis/git-token-jarvisbuild" });
    expect(parse(withCreds({ "a/b": { source: "file", token_file: "/etc/x" } })).runner.gitCredentials["a/b"]).toEqual({ source: "file", tokenFile: "/etc/x" });
    // request: ingen fil
    const req = parse(withCreds({ "a/b": { source: "request" } })).runner.gitCredentials["a/b"];
    expect(req).toEqual({ source: "request" });
    expect("tokenFile" in req).toBe(false);
    expect(Object.isFrozen(req)).toBe(true);
    // blandet konfig: ett repo per kilde
    const mixed = parse(withCreds({ "a/b": { source: "request" }, "c/d": { token_file: "/etc/y" } })).runner.gitCredentials;
    expect(mixed["a/b"].source).toBe("request");
    expect(mixed["c/d"].source).toBe("file");
    // tvetydig: request + token_file nektes (ikke «request med fil som reserve»)
    expect(code(() => parse(withCreds({ "a/b": { source: "request", token_file: "/etc/x" } })))).toContain("token_file_not_allowed_with_source_request");
    // file uten fil nektes
    expect(code(() => parse(withCreds({ "a/b": { source: "file" } })))).toContain("token_file");
    expect(code(() => parse(withCreds({ "a/b": {} })))).toContain("token_file");
    // ugyldige verdier: ingen stille standard (null, tom streng, feil case, tall, boolsk, liste)
    for (const source of [null, "", "REQUEST", "Request", "File", "pat", "app", "github-app", "both", 1, true, ["request"], { a: 1 }]) {
      expect(code(() => parse(withCreds({ "a/b": { source, token_file: "/etc/x" } }))), JSON.stringify(source)).toContain("source:file_or_request");
    }
    // ukjente nøkler (stavefeil i et sikkerhetsflagg blir aldri stille ignorert)
    for (const key of ["accept_request_token", "allow_request_token", "token", "git_token", "request", "fallback", "source_file"]) {
      expect(code(() => parse(withCreds({ "a/b": { source: "request", [key]: true } }))), key).toContain("config_unknown_key");
    }
    // request-repo må fortsatt stå i allowed_repos (og omvendt: hvert allowlistet repo har en kilde)
    expect(code(() => parse({ ...runner(), git_credentials: { ...runner().git_credentials, "other/repo": { source: "request" } } }))).toContain("not_in_allowed_repos");
    expect(code(() => parse({ ...runner(), allowed_repos: ["a/b", "c/d"], git_credentials: { "a/b": { source: "request" } } }))).toContain("missing_credential_for_allowed_repo");
  });

  it("env_allow: standard er KUN ANTHROPIC_API_KEY; vertsadmin kan åpne flere ufarlige navn, men aldri et navn deny-listen stopper (PATH, LD_*, DOCKER_*, git-/credential-navn)", () => {
    expect(parse(runner()).runner.envAllow).toEqual(["ANTHROPIC_API_KEY"]);
    expect(parse({ ...runner(), env_allow: ["ANTHROPIC_API_KEY", "CI", "ANTHROPIC_API_KEY"] }).runner.envAllow).toEqual(["ANTHROPIC_API_KEY", "CI"]); // duplikater slås sammen
    expect(parse({ ...runner(), env_allow: [] }).runner.envAllow).toEqual([]); // ingen env i det hele tatt er lov
    for (const name of ["PATH", "HOME", "LD_PRELOAD", "DOCKER_HOST", "HTTPS_PROXY", "GITHUB_TOKEN", "GH_TOKEN", "JARVIS_GIT_CREDENTIAL_TOKEN", "GIT_SSH_COMMAND", "GCONV_PATH", "LOCPATH", "TMPDIR", "GODEBUG", "BASH_ENV", "INFISICAL_CLIENT_SECRET", "POSTGRES_PASSWORD", "path"]) {
      expect(code(() => parse({ ...runner(), env_allow: ["ANTHROPIC_API_KEY", name] })), name).toBe("config_invalid:runner.env_allow:name_forbidden");
    }
    for (const bad of ["1BAD", "A=B", "a b", "", "A-B", "ÆØÅ", "A".repeat(101) + "_"]) expect(code(() => parse({ ...runner(), env_allow: [bad] })), bad).toContain("config_invalid");
    expect(code(() => parse({ ...runner(), env_allow: "ANTHROPIC_API_KEY" }))).toContain("env_allow:list");
    expect(code(() => parse({ ...runner(), env_allow: Array.from({ length: 17 }, (_, i) => `NAME_${i}`) }))).toContain("env_allow:list");
    expect(code(() => parse({ ...runner(), env_allow: [null] }))).toContain("env_allow");
  });

  it("branch-prefiks må ende på «/» (main/master/production blir strukturelt umulig)", () => {
    for (const branch_prefix of ["", "jarvis", "/", "jarvis//", "Jarvis/", "../"]) expect(code(() => parse({ ...runner(), branch_prefix })), branch_prefix).toContain("branch_prefix");
    expect(code(() => parse({ ...runner(), branch_prefix: "bots/" }))).toBe("no_error");
  });

  it("publiseringsgrenser og nektelisten valideres", () => {
    for (const publish of [{ max_commits: 0 }, { max_commits: 501 }, { max_bundle_bytes: 10 }, { max_files: 0 }, { deny_paths: ["/abs"] }, { deny_paths: ["a/../b"] }, { deny_paths: "x" }, { deny_paths: ["."] }, { deny_paths: ["./x"] }, { deny_paths: ["a/./b"] }]) {
      expect(code(() => parse({ ...runner(), publish })), JSON.stringify(publish)).toContain("config_invalid");
    }
    expect(parse({ ...runner(), publish: { deny_paths: [".github/", "secrets/"] } }).runner.publish.denyPaths).toEqual([".github/", "secrets/"]);
  });

  it("A-F3: git_memory_limit_mb (adresserom-grense for vertsside git som parser agentens pakke) og prlimit_bin - standard, grenser og krysskontroll mot bundle-taket", () => {
    const r = parse(runner()).runner;
    expect(r.gitMemoryLimitMb).toBe(1024);
    expect(r.prlimitBin).toBe("/usr/bin/prlimit");
    expect(parse({ ...runner(), git_memory_limit_mb: 4096, prlimit_bin: "/usr/local/bin/prlimit" }).runner).toMatchObject({ gitMemoryLimitMb: 4096, prlimitBin: "/usr/local/bin/prlimit" });
    for (const git_memory_limit_mb of [0, 255, 65_537, 1.5, "1024", null, -1]) expect(code(() => parse({ ...runner(), git_memory_limit_mb })), String(git_memory_limit_mb)).toContain("git_memory_limit_mb");
    for (const prlimit_bin of ["prlimit", "../prlimit", "/usr/bin/../bin/prlimit", "/usr//bin/prlimit", 5, "", "/bin/pr limit"]) expect(code(() => parse({ ...runner(), prlimit_bin })), String(prlimit_bin)).toContain("prlimit_bin");
    // grensen må rekke over bundle-taket + 256 MiB arbeidsminne, ellers ville legitime publish feilet med «Out of memory»
    expect(code(() => parse({ ...runner(), publish: { max_bundle_bytes: 512 * 1024 * 1024 } }))).toBe("no_error"); // 512 + 256 = 768 <= 1024
    expect(code(() => parse({ ...runner(), git_memory_limit_mb: 512, publish: { max_bundle_bytes: 512 * 1024 * 1024 } }))).toContain("must_cover_max_bundle_bytes_plus_256_mb");
    expect(code(() => parse({ ...runner(), git_memory_limit_mb: 320, publish: { max_bundle_bytes: 64 * 1024 * 1024 } }))).toBe("no_error"); // 64 + 256 = 320
    expect(code(() => parse({ ...runner(), git_memory_limit_mb: 319, publish: { max_bundle_bytes: 64 * 1024 * 1024 } }))).toContain("must_cover_max_bundle_bytes_plus_256_mb");
  });

  it("git-identitet: smalt tegnsett", () => {
    expect(code(() => parse({ ...runner(), git_identity: { name: 'x"; rm -rf /', email: "a@b.c" } }))).toContain("git_identity");
    expect(code(() => parse({ ...runner(), git_identity: { name: "ok", email: "not-an-email" } }))).toContain("git_identity");
  });

  it("socket_group og docker_host: kun trygge former", () => {
    expect(code(() => parse({ ...runner(), socket_group: "jarvis-job-clients" }))).toBe("no_error");
    expect(code(() => parse({ ...runner(), socket_group: "1010" }))).toBe("no_error");
    expect(code(() => parse({ ...runner(), socket_group: "a b" }))).toContain("socket_group");
    expect(code(() => parse({ ...runner(), docker_host: "tcp://127.0.0.1:2375" }))).toContain("docker_host");
    expect(code(() => parse({ ...runner(), docker_host: "unix:///var/run/docker.sock" }))).toBe("no_error");
  });
});

describe("D: egress-proxy-policy valideres fail-closed", () => {
  it("lytteadresse: aldri jokertegn (0.0.0.0, ::), aldri vertsnavn - kun en bestemt IPv4", () => {
    for (const listen_host of ["0.0.0.0", "::", "::1", "localhost", "", "172.30.77", "1.2.3.4.5"]) {
      expect(code(() => parse(undefined, { ...proxy(), listen_host })), listen_host).toContain("listen_host");
    }
    expect(code(() => parse(undefined, { ...proxy(), listen_host: "127.0.0.1" }))).toBe("no_error");
  });

  it("allowlist: kun DNS-navn:port (ingen IP-literaler, jokertegn, entall-etiketter, ugyldige porter)", () => {
    for (const entry of ["*.github.com:443", "1.2.3.4:443", "localhost:443", "github.com", "github.com:0", "github.com:70000", "git hub.com:443", "http://github.com:443", "github.com:443/path"]) {
      expect(code(() => parse(undefined, { ...proxy(), allow: [entry] })), entry).toContain("config_invalid");
    }
    // vertsnavn i konfigen må være lavere-case (strengt format - ingen stille normalisering som kan skjule en skrivefeil)
    expect(code(() => parse(undefined, { ...proxy(), allow: ["GitHub.com:443"] }))).toContain("config_invalid");
    expect(parse(undefined, { ...proxy(), allow: ["github.com:443", "github.com:443"] }).egressProxy.allow).toEqual(["github.com:443"]);
  });

  it("klient-CIDR er påkrevd; for brede nett og ugyldige former avvises", () => {
    expect(code(() => parse(undefined, { listen_host: "172.30.77.1" }))).toContain("allowed_client_cidrs:required");
    for (const cidr of ["0.0.0.0/0", "0.0.0.0/4", "172.30.77.0/33", "172.30.77.0", "garbage", "::/0"]) {
      expect(code(() => parse(undefined, { ...proxy(), allowed_client_cidrs: [cidr] })), cidr).toContain("config_invalid");
    }
    // B-L7: klientene er jobbnettverket - prefiks 16-32, nettverksadresse, og hele området innenfor et privat nett (RFC 1918). Før ble 0.0.0.0/8, 8.0.0.0/8 og 10.0.0.0/8 godtatt.
    const cidrError = (cidr) => code(() => parse(undefined, { ...proxy(), allowed_client_cidrs: [cidr] }));
    for (const cidr of ["0.0.0.0/8", "8.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/15", "172.30.0.0/15"]) expect(cidrError(cidr), cidr).toContain("prefix_16_32");
    for (const cidr of ["8.8.8.0/24", "1.1.1.0/24", "172.15.0.0/16", "172.32.0.0/16", "100.64.0.0/16", "127.0.0.0/24", "169.254.0.0/16", "192.169.0.0/16", "11.0.0.0/16", "0.0.0.0/16", "224.0.0.0/16", "255.255.255.0/24"]) {
      expect(cidrError(cidr), cidr).toContain("must_be_private_network");
    }
    for (const cidr of ["172.30.77.5/24", "10.0.0.1/16", "192.168.1.128/24"]) expect(cidrError(cidr), cidr).toContain("host_bits_set");
    for (const cidr of ["172.30.77.0/24", "10.1.2.0/24", "10.0.0.0/16", "192.168.1.0/24", "192.168.0.0/16", "172.16.0.0/16", "172.31.255.0/24", "172.30.77.1/32", "10.255.0.0/16"]) expect(cidrError(cidr), cidr).toBe("no_error");
    expect(parse(undefined, { ...proxy(), allowed_client_cidrs: ["172.30.77.0/24", "10.9.0.0/16"] }).egressProxy.allowedClientCidrs).toEqual([{ network: "172.30.77.0", prefix: 24 }, { network: "10.9.0.0", prefix: 16 }]);
  });
});

describe("E: loadConfigFile - filen må eies av root og ikke være skrivbar for andre", () => {
  const writeConfig = async (mode, body = { version: 1, runner: runner() }) => {
    const dir = await makeTempDir("jr-cfg-");
    const file = join(dir, "job-runner.json");
    await writeFile(file, typeof body === "string" ? body : JSON.stringify(body), { mode });
    await chmod(file, mode);
    return { dir, file };
  };
  const err = async (promise) => {
    try { await promise; } catch (e) { return e instanceof ConfigError ? e.code : `other:${e}`; }
    return "no_error";
  };

  it("nekter ikke-root-eid fil som standard (tjenesten kan ikke endre sin egen policy)", async () => {
    const { file } = await writeConfig(0o644);
    expect(await err(loadConfigFile(file, { require: ["runner"] }))).toBe("config_must_be_owned_by_root");
  });

  it("med allowNonRootOwner (KUN tester): laster gyldig fil", async () => {
    const { file } = await writeConfig(0o644);
    const loaded = await loadConfigFile(file, { require: ["runner"], allowNonRootOwner: true });
    expect(loaded.runner.allowedRepos).toEqual(["tsworkflow/jarvisbuild"]);
  });

  it("nekter gruppe-/verdensskrivbar fil, symlenke, ugyldig JSON, for stor fil og relativ sti", async () => {
    expect(await err(loadConfigFile((await writeConfig(0o664)).file, { require: ["runner"], allowNonRootOwner: true }))).toBe("config_writable_by_group_or_others");
    expect(await err(loadConfigFile((await writeConfig(0o646)).file, { require: ["runner"], allowNonRootOwner: true }))).toBe("config_writable_by_group_or_others");
    const real = await writeConfig(0o644);
    const link = join(real.dir, "link.json");
    await symlink(real.file, link);
    expect(await err(loadConfigFile(link, { require: ["runner"], allowNonRootOwner: true }))).toBe("config_unreadable");
    expect(await err(loadConfigFile((await writeConfig(0o644, "{not json")).file, { require: ["runner"], allowNonRootOwner: true }))).toBe("config_not_valid_json");
    expect(await err(loadConfigFile((await writeConfig(0o644, " ".repeat(70_000))).file, { require: ["runner"], allowNonRootOwner: true }))).toBe("config_too_large");
    expect(await err(loadConfigFile("relative.json", { require: ["runner"] }))).toBe("config_path_not_absolute");
    expect(await err(loadConfigFile(join(real.dir, "missing.json"), { require: ["runner"], allowNonRootOwner: true }))).toBe("config_unreadable");
    expect(await err(loadConfigFile(real.dir, { require: ["runner"], allowNonRootOwner: true }))).toMatch(/config_(unreadable|not_a_regular_file)/);
  });
});
