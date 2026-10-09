import { describe, expect, it } from "vitest";
import * as workerSide from "../../../modules/tasks/src/job-container.ts";
import * as sharedSpec from "../../../modules/tasks/src/job-container-spec.mjs";
import * as hostSide from "../lib/spec.mjs";

/**
 * WP-C1: ÉN kilde til container-sikkerhetsflaggene. Worker-siden (`job-container.ts`, den eldre `container`-modusen) og den
 * vertsside runneren (`ops/job-runner`) må bruke NØYAKTIG de samme funksjonene - ikke to kopier som kan drive fra hverandre.
 */

const ID = "123e4567-e89b-42d3-a456-426614174000";
const NAME = `jarvis-job-${ID}`;
const policy = {
  image: `sha256:${"a".repeat(64)}`, network: "jarvis-jobs", egressProxyUrl: "http://172.30.77.1:3128", pull: /** @type {"never"} */ ("never")
};
const job = { containerName: NAME, workdir: "/var/lib/jarvis-job-runner/jobs/x/work", envNames: ["ANTHROPIC_API_KEY"] };

describe("A: én kilde (identitet, ikke kopi)", () => {
  it("job-container.ts re-eksporterer SAMME funksjonsobjekter som den delte .mjs-filen", () => {
    expect(workerSide.buildJobContainerCreateArgs).toBe(sharedSpec.buildJobContainerCreateArgs);
    expect(workerSide.validateJobContainerPolicy).toBe(sharedSpec.validateJobContainerPolicy);
    expect(workerSide.JobContainerConfigError).toBe(sharedSpec.JobContainerConfigError);
  });

  it("vertstjenesten importerer samme objekter (ops/job-runner/lib/spec.mjs -> modules/tasks/src/job-container-spec.mjs)", () => {
    expect(hostSide.buildJobContainerCreateArgs).toBe(sharedSpec.buildJobContainerCreateArgs);
    expect(hostSide.validateJobContainerPolicy).toBe(sharedSpec.validateJobContainerPolicy);
    expect(hostSide.FORBIDDEN_ENV).toBe(sharedSpec.FORBIDDEN_ENV);
    expect(hostSide.HOST_RUNNER_FORBIDDEN_ENV).toBe(sharedSpec.HOST_RUNNER_FORBIDDEN_ENV);
  });
});

describe("B: docker create-argv for vertsside runner - grensene er faktisk til stede", () => {
  const args = sharedSpec.buildJobContainerCreateArgs(policy, {
    ...job, taskId: "task-1", fixedEnv: { GIT_AUTHOR_NAME: "jarvis worker", GIT_AUTHOR_EMAIL: "worker@jarvis.local" }
  });
  const has = (flag, value) => {
    const i = args.indexOf(flag);
    return i >= 0 && (value === undefined || args[i + 1] === value);
  };

  it("ikke-root, read-only rootfs, alle capabilities droppet, no-new-privileges, ingen swap", () => {
    expect(has("--user", "10001:10001")).toBe(true);
    expect(has("--read-only")).toBe(true);
    expect(has("--cap-drop", "ALL")).toBe(true);
    expect(has("--security-opt", "no-new-privileges:true")).toBe(true);
    expect(has("--memory", "1g")).toBe(true);
    expect(has("--memory-swap", "1g")).toBe(true);
    expect(has("--pids-limit", "256")).toBe(true);
    expect(has("--cpus", "1.0")).toBe(true);
    expect(has("--init")).toBe(true);
  });

  it("kun /work er montert (bind), tmpfs for /tmp og /home/job, ingen volumer/socket/devices", () => {
    expect(args.filter((a) => a.startsWith("type=bind"))).toEqual([`type=bind,source=${job.workdir},target=/work`]);
    expect(args.filter((a) => a.startsWith("/tmp:") || a.startsWith("/home/job:"))).toHaveLength(2);
    for (const forbidden of ["--privileged", "--pid", "--ipc", "--uts", "--device", "--cap-add", "--volumes-from", "--env-file", "--userns", "-v", "--volume", "--network=host"]) {
      expect(args, forbidden).not.toContain(forbidden);
    }
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("--network host");
  });

  it("kun det dedikerte jobbnettverket; proxy via env; ingen lokale images byttes ut av registry (--pull never)", () => {
    expect(has("--network", "jarvis-jobs")).toBe(true);
    expect(args.join(" ")).toContain("HTTPS_PROXY=http://172.30.77.1:3128");
    expect(has("--pull", "never")).toBe(true);
    expect(args.at(-3)).toBe(policy.image);
    expect(args.slice(-2)).toEqual(["sleep", "infinity"]);
  });

  it("merkelapper for sporbarhet (rolle + task_id); konstante env-verdier kun for ikke-hemmelig identitet", () => {
    expect(args).toContain("jarvis.role=job");
    expect(args).toContain("jarvis.task_id=task-1");
    expect(args).toContain("GIT_AUTHOR_NAME=jarvis worker");
  });

  it("hemmelige env-verdier står ALDRI i argv: kun NAVN (siste -e er jobb-env-navnet)", () => {
    const i = args.lastIndexOf("-e");
    expect(args[i + 1]).toBe("ANTHROPIC_API_KEY");
    expect(args.join(" ")).not.toMatch(/ANTHROPIC_API_KEY=/);
  });

  it("/home/job (tmpfs) eies av samme uid:gid som prosessen i containeren - også når policy.user ikke er standarden", () => {
    const tmpfsFor = (user) => {
      const a = sharedSpec.buildJobContainerCreateArgs({ ...policy, ...(user ? { user } : {}) }, job);
      return a.find((x) => x.startsWith("/home/job:"));
    };
    expect(tmpfsFor(undefined)).toMatch(/,uid=10001,gid=10001$/);
    expect(tmpfsFor("1001:1002")).toMatch(/,uid=1001,gid=1002$/);
    expect(tmpfsFor("1001:1002")).toContain("noexec,nosuid,nodev");
    const a = sharedSpec.buildJobContainerCreateArgs({ ...policy, user: "1001:1002" }, job);
    expect(a[a.indexOf("--user") + 1]).toBe("1001:1002");
  });
});

describe("C: policy-validering (fail-closed)", () => {
  it("godtar digest-pinnet image og lokalt image-ID; nekter flytende tagger", () => {
    expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, image: `node:22@sha256:${"b".repeat(64)}` })).not.toThrow();
    expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, image: `sha256:${"b".repeat(64)}` })).not.toThrow();
    for (const image of ["node:22", "node:latest", "node", `sha256:${"B".repeat(64)}`, "sha256:short", `sha256:${"b".repeat(63)}`, `foo bar@sha256:${"b".repeat(64)}`]) {
      expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, image }), image).toThrow(sharedSpec.JobContainerConfigError);
    }
  });

  it("nekter host/bridge/none/default-nettverk, root, ugyldig proxy, og ugyldige ressursverdier", () => {
    for (const network of ["host", "bridge", "none", "default", "", "A B", "-x"]) {
      expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, network }), network).toThrow(sharedSpec.JobContainerConfigError);
    }
    for (const user of ["0:0", "0", "root", "0:10001"]) {
      expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, user }), user).toThrow(sharedSpec.JobContainerConfigError);
    }
    for (const egressProxyUrl of ["", "ikke-url", "ftp://p:3128", "http://bruker:pw@p:3128"]) {
      expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, egressProxyUrl }), egressProxyUrl).toThrow(sharedSpec.JobContainerConfigError);
    }
    expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, memory: "1g --privileged" })).toThrow(sharedSpec.JobContainerConfigError);
    expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, cpus: "1.0 --privileged" })).toThrow(sharedSpec.JobContainerConfigError);
    expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, pidsLimit: 1 })).toThrow(sharedSpec.JobContainerConfigError);
    expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, tmpfsSize: "10" })).toThrow(sharedSpec.JobContainerConfigError);
    // bevisst ugyldig pull-policy
    expect(() => sharedSpec.validateJobContainerPolicy({ ...policy, pull: "always" })).toThrow(sharedSpec.JobContainerConfigError);
  });

  it("nekter usikre stier, containernavn, task-merkelapp og env-navn (mount-/argv-injeksjon)", () => {
    for (const workdir of ["relativ", "/tmp/a,source=/", "/tmp/../etc", "/tmp/a b", "/var/run/docker.sock\n"]) {
      expect(() => sharedSpec.buildJobContainerCreateArgs(policy, { ...job, workdir }), workdir).toThrow(sharedSpec.JobContainerConfigError);
    }
    expect(() => sharedSpec.buildJobContainerCreateArgs(policy, { ...job, containerName: "--privileged" })).toThrow(sharedSpec.JobContainerConfigError);
    expect(() => sharedSpec.buildJobContainerCreateArgs(policy, { ...job, taskId: "x --privileged" })).toThrow(sharedSpec.JobContainerConfigError);
    for (const name of ["INFISICAL_ENCRYPTION_KEY", "JARVIS_DB_PASSWORD", "PGPASSWORD", "NEXTAUTH_SECRET", "1BAD", "A=B"]) {
      expect(() => sharedSpec.buildJobContainerCreateArgs(policy, { ...job, envNames: [name] }), name).toThrow(sharedSpec.JobContainerConfigError);
    }
  });

  it("konstante env-verdier: smalt tegnsett (ingen anførselstegn, linjeskift, shell-metategn) og ingen policy-eide/forbudte navn", () => {
    for (const value of ["a\nb", 'a"b', "a`b", "a$(b)", "a;b", "a|b", "x".repeat(201)]) {
      expect(() => sharedSpec.buildJobContainerCreateArgs(policy, { ...job, fixedEnv: { GIT_AUTHOR_NAME: value } }), value).toThrow(sharedSpec.JobContainerConfigError);
    }
    for (const name of ["HTTPS_PROXY", "HOME", "PATH", "LD_PRELOAD", "JARVIS_GIT_CREDENTIAL_TOKEN", "GITHUB_TOKEN", "INFISICAL_X", "bad name"]) {
      expect(() => sharedSpec.buildJobContainerCreateArgs(policy, { ...job, fixedEnv: { [name]: "x" } }), name).toThrow(sharedSpec.JobContainerConfigError);
    }
  });
});

describe("D: jobb-env for vertsside runner - git-credentials går ALDRI inn i containeren", () => {
  const forbidden = [
    "JARVIS_GIT_CREDENTIAL_TOKEN", "JARVIS_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_AUTH_SOCK",
    "GIT_TERMINAL_PROMPT", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG", "GIT_SSH_COMMAND", "GIT_DIR", "GIT_EXEC_PATH",
    "HOME", "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DOCKER_HOST", "HTTP_PROXY", "https_proxy", "NO_PROXY", "ALL_PROXY",
    "INFISICAL_CLIENT_SECRET", "JARVIS_DB_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD", "LANGFUSE_SECRET_KEY", "FOO_ENCRYPTION_KEY", "1BAD", "A=B", "",
    // GitHub App (WP-C3): nøkkel, app-id og installasjon hører aldri hjemme i en jobb-container
    "JARVIS_GITHUB_APP_PRIVATE_KEY", "JARVIS_GITHUB_APP_ID", "JARVIS_GITHUB_APP_INSTALLATION_ID", "JARVIS_GITHUB_REPO", "GITHUB_APP_PRIVATE_KEY", "GITHUB_PRIVATE_KEY",
    // navn som styrer en prosess PÅ VERTEN (jobb-env settes i miljøet til den vertsside docker-klienten): libc/Go-kjøretid, temp/konfig-kataloger, CA-stier, shell-oppstart
    "GCONV_PATH", "LOCPATH", "NLSPATH", "HOSTALIASES", "RES_OPTIONS", "LOCALDOMAIN", "GLIBC_TUNABLES", "MALLOC_PERTURB_", "MALLOC_CONF", "TZDIR", "TMPDIR", "TMP", "TEMP",
    "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "GODEBUG", "GOGC", "GOMAXPROCS", "GOMEMLIMIT", "GOTRACEBACK", "GOFLAGS",
    "BASH_ENV", "ENV", "SHELL", "IFS", "PROMPT_COMMAND", "SHELLOPTS",
    // samme navn i andre store/små bokstaver (regex er case-insensitiv: lavere-case varianter leses av mange verktøy)
    "gconv_path", "Path", "home", "ld_preload", "docker_host", "godebug", "tmpdir"
  ];
  it("nekter credential-, git-konfig-, proxy- og vault-navn, GitHub App-navn og navn som styrer en vertsprosess", () => {
    for (const name of forbidden) expect(sharedSpec.isHostRunnerEnvNameAllowed(name), name).toBe(false);
  });
  it("tillater vanlige navn (også de som LIGNER på forbudte uten å være det)", () => {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CI", "TZ", "LANG", "LC_ALL", "MY_SETTING", "GIT_AUTHOR_NAME", "GOOGLE_API_KEY", "GOARCH_X", "GITHUB_ACTIONS", "NODE_ENV", "ENVIRONMENT", "SHELLY", "TMPFILE", "TEMPLATE", "XDG", "HOMEPAGE", "PATHS", "LD", "MY_GODEBUG", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
      expect(sharedSpec.isHostRunnerEnvNameAllowed(name), name).toBe(true);
    }
  });
  it("navnene ligger i det delte regulære uttrykket (én kilde), ikke i en kopi", () => {
    expect(sharedSpec.HOST_RUNNER_FORBIDDEN_ENV.flags).toContain("i");
    expect(sharedSpec.HOST_RUNNER_FORBIDDEN_ENV.source.startsWith("^(?:")).toBe(true);
  });
});
