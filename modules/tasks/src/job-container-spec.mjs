/**
 * WP-C1 (D-32 / Q-45a / Q-46 punkt 5): DEN ENESTE kilden til container-sikkerhetsflaggene for kodejobber.
 *
 * Ren `.mjs` uten avhengigheter, med håndskrevet typefil (`job-container-spec.d.mts`), fordi to uavhengige
 * kjøremiljøer må dele nøyaktig samme logikk uten byggesteg:
 *   - worker-siden (`modules/tasks/src/job-container.ts`, bundlet i api-imaget der `ops/` IKKE finnes), og
 *   - den tilsynte vertstjenesten (`ops/job-runner/`, ren Node-ESM som kjøres direkte av `node` på verten).
 * Begge importerer denne filen; `ops/job-runner/test/container-spec.test.mjs` låser at `job-container.ts`
 * re-eksporterer SAMME funksjonsobjekter (identitetssjekk), slik at flaggene aldri kan drive fra hverandre.
 *
 * Ingen funksjon her kjører noe: de validerer og bygger KUN `docker create`-argv (aldri hemmelige VERDIER -
 * kun env-NAVN, verdiene leveres i docker-prosessens egen env).
 */

import { URL } from "node:url";

const DIGEST_PINNED_IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;
/**
 * WP-C1: en LOKALT bygget image har ingen registry-digest (RepoDigests er tom til den pushes), men dens image-ID
 * (`sha256:<64 hex>`) er innholdsadressert og uforanderlig. Med `--pull never` kan den heller aldri byttes ut av en
 * registry. Godtas derfor på lik linje med `navn@sha256:...`.
 */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const NETWORK_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const FORBIDDEN_NETWORKS = new Set(["host", "bridge", "none", "default"]);
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Navn som ALDRI kan inn i en jobb-container (vault-hovednøkkel, DB-superbruker, observability-hemmeligheter m.m.). */
const FORBIDDEN_ENV =
  /^(INFISICAL_|JARVIS_DB_|POSTGRES_|PG|NEXTAUTH_|SALT$|LANGFUSE_|AUTH_SECRET$|ENCRYPTION_KEY$|JARVIS_BROWSER_GATEWAY_TOKEN_SECRET$)|(_ENCRYPTION_KEY|_MASTER_KEY|_PRIVATE_KEY_PEM)$/;

/**
 * WP-C1: ekstra regler som gjelder KUN den vertsside runneren (ikke den eldre `container`-modusen, som beholdes uendret):
 *  - git-credentials går ALDRI inn i jobb-containeren, verken som navngitt token, askpass, credential-helper eller SSH-agent;
 *  - navn policyen selv eier (proxy, HOME, PATH, dynamisk lenker) kan ikke overstyres fra API-et.
 */
const HOST_RUNNER_FORBIDDEN_ENV =
  /^(JARVIS_GIT_CREDENTIAL_TOKEN|JARVIS_GITHUB_TOKEN|GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_PAT|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_TERMINAL_PROMPT|GIT_EXEC_PATH|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG|GIT_CONFIG_[A-Z0-9_]*|GIT_SSH|GIT_SSH_COMMAND|GIT_PROXY_COMMAND|HOME|PATH|LD_[A-Z_]*|DOCKER_[A-Z_]*|(?:ALL|HTTPS?|NO|FTP)_PROXY)$/i;

const MEMORY = /^[1-9][0-9]{0,5}[kKmMgG]?$/;
const TMPFS_SIZE = /^[1-9][0-9]{0,5}[kKmMgG]$/;
const CPUS = /^[0-9]+(?:\.[0-9]{1,2})?$/;
const TASK_LABEL_VALUE = /^[A-Za-z0-9._:-]{1,100}$/;
const FIXED_ENV_VALUE = /^[A-Za-z0-9 ._@:/+=,-]{0,200}$/;

class JobContainerConfigError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`job_container_config_invalid:${reason}`);
    this.name = "JobContainerConfigError";
    /** @type {string} */
    this.reason = reason;
  }
}

/**
 * Er navnet tillatt som jobb-env hos den vertsside runneren? (syntaks + legacy-forbudsliste + runner-spesifikke regler)
 * @param {string} name
 */
function isHostRunnerEnvNameAllowed(name) {
  return typeof name === "string" && name.length <= 100 && ENV_NAME.test(name) && !FORBIDDEN_ENV.test(name) && !HOST_RUNNER_FORBIDDEN_ENV.test(name);
}

/** @param {import("./job-container-spec.d.mts").JobContainerPolicy} policy */
function validateJobContainerPolicy(policy) {
  if (!(policy.allowUnpinnedImage === true) && !DIGEST_PINNED_IMAGE.test(policy.image) && !IMAGE_ID.test(policy.image)) {
    throw new JobContainerConfigError("image_not_digest_pinned");
  }
  if (!NETWORK_NAME.test(policy.network) || FORBIDDEN_NETWORKS.has(policy.network)) {
    throw new JobContainerConfigError("network_must_be_a_dedicated_jobs_network");
  }
  let proxy;
  try {
    proxy = new URL(policy.egressProxyUrl);
  } catch {
    throw new JobContainerConfigError("egress_proxy_url_invalid");
  }
  if (!(proxy.protocol === "http:" || proxy.protocol === "https:") || proxy.username !== "" || proxy.password !== "") {
    throw new JobContainerConfigError("egress_proxy_url_invalid");
  }
  const user = policy.user ?? "10001:10001";
  if (!/^\d+:\d+$/.test(user) || user.startsWith("0:") || user === "0") {
    throw new JobContainerConfigError("user_must_be_non_root_numeric");
  }
  if (policy.memory !== undefined && !MEMORY.test(policy.memory)) throw new JobContainerConfigError("memory_invalid");
  if (policy.tmpfsSize !== undefined && !TMPFS_SIZE.test(policy.tmpfsSize)) throw new JobContainerConfigError("tmpfs_size_invalid");
  if (policy.cpus !== undefined && (!CPUS.test(policy.cpus) || Number(policy.cpus) <= 0 || Number(policy.cpus) > 64)) throw new JobContainerConfigError("cpus_invalid");
  if (policy.pidsLimit !== undefined && !(Number.isInteger(policy.pidsLimit) && policy.pidsLimit >= 16 && policy.pidsLimit <= 32768)) {
    throw new JobContainerConfigError("pids_limit_invalid");
  }
  if (policy.pull !== undefined && policy.pull !== "never") throw new JobContainerConfigError("pull_policy_invalid");
}

/**
 * Ren, deterministisk bygging av `docker create`-argv. Returnerer aldri hemmelige VERDIER - kun env-NAVN.
 * `job.fixedEnv` er for KONSTANTE, ikke-hemmelige verdier (git-identitet m.m.) og er det eneste stedet en env-VERDI står i argv;
 * den valideres derfor strengt (smalt tegnsett). `job.taskId` merker containeren (CLAUDE.md regel 4: alt er merket).
 *
 * @param {import("./job-container-spec.d.mts").JobContainerPolicy} policy
 * @param {import("./job-container-spec.d.mts").JobContainerJob} job
 * @returns {string[]}
 */
function buildJobContainerCreateArgs(policy, job) {
  validateJobContainerPolicy(policy);
  if (!SAFE_PATH.test(job.workdir) || job.workdir.includes("..")) {
    throw new JobContainerConfigError("workdir_path_unsafe");
  }
  if (!/^jarvis-job-[a-f0-9-]{36}$/.test(job.containerName)) {
    throw new JobContainerConfigError("container_name_invalid");
  }
  for (const name of job.envNames) {
    if (!ENV_NAME.test(name) || FORBIDDEN_ENV.test(name)) {
      throw new JobContainerConfigError(`env_name_forbidden:${name}`);
    }
  }
  const fixedEntries = Object.entries(job.fixedEnv ?? {});
  for (const [name, value] of fixedEntries) {
    if (!ENV_NAME.test(name) || FORBIDDEN_ENV.test(name) || HOST_RUNNER_FORBIDDEN_ENV.test(name)) {
      throw new JobContainerConfigError(`fixed_env_name_forbidden:${name}`);
    }
    if (typeof value !== "string" || !FIXED_ENV_VALUE.test(value)) {
      throw new JobContainerConfigError(`fixed_env_value_invalid:${name}`);
    }
  }
  if (job.taskId !== undefined && !TASK_LABEL_VALUE.test(job.taskId)) {
    throw new JobContainerConfigError("task_id_label_invalid");
  }
  const proxy = policy.egressProxyUrl;
  const user = policy.user ?? "10001:10001";
  // /home/job (tmpfs) må eies av samme uid:gid som prosessen i containeren, ellers kan ikke HOME skrives (Claude Code/git).
  const [homeUid, homeGid] = user.split(":");
  return [
    "create",
    "--name", job.containerName,
    "--init", // PID 1 høster zombier og videresender signaler
    ...(policy.pull === "never" ? ["--pull", "never"] : []),
    "--read-only",
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${policy.tmpfsSize ?? "256m"}`,
    "--tmpfs", `/home/job:rw,noexec,nosuid,nodev,size=${policy.tmpfsSize ?? "256m"},uid=${homeUid},gid=${homeGid}`,
    "--mount", `type=bind,source=${job.workdir},target=/work`,
    "--workdir", "/work",
    "--user", user,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--memory", policy.memory ?? "1g",
    "--memory-swap", policy.memory ?? "1g",
    "--cpus", policy.cpus ?? "1.0",
    "--pids-limit", String(policy.pidsLimit ?? 256),
    "--network", policy.network,
    "--label", "jarvis.role=job",
    ...(job.taskId !== undefined ? ["--label", `jarvis.task_id=${job.taskId}`] : []),
    "-e", `HTTP_PROXY=${proxy}`, "-e", `HTTPS_PROXY=${proxy}`, "-e", `http_proxy=${proxy}`, "-e", `https_proxy=${proxy}`,
    "-e", "NO_PROXY=", "-e", "no_proxy=",
    "-e", "HOME=/home/job",
    ...fixedEntries.flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    ...job.envNames.flatMap((name) => ["-e", name]),
    policy.image,
    "sleep", "infinity"
  ];
}

export {
  DIGEST_PINNED_IMAGE, ENV_NAME, FORBIDDEN_ENV, FORBIDDEN_NETWORKS, HOST_RUNNER_FORBIDDEN_ENV, IMAGE_ID, JobContainerConfigError,
  NETWORK_NAME, SAFE_PATH, buildJobContainerCreateArgs, isHostRunnerEnvNameAllowed, validateJobContainerPolicy
};
