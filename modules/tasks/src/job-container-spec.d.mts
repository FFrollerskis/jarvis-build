/**
 * Typer for `job-container-spec.mjs` (WP-C1). Holdes i takt med .mjs-filen for hånd - `ops/job-runner/test/container-spec.test.mjs`
 * kjører begge sidene mot samme inndata, så en glipp her gir ikke stille drift i selve flaggene (de bor kun i .mjs-filen).
 */

export interface JobContainerPolicy {
  /** Image PINNET til digest (`navn@sha256:<64 hex>`) eller lokalt image-ID (`sha256:<64 hex>`). Flytende tagger nektes. */
  image: string;
  /** Eksisterende docker-nettverk for jobber (internal; når kun egress-proxyen). `host`/`bridge`/`none` nektes. */
  network: string;
  /** `http(s)://host:port` til egress-proxyen med vert-allowlist (github.com, api.anthropic.com). */
  egressProxyUrl: string;
  user?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  tmpfsSize?: string;
  dockerBin?: string;
  /** KUN tester: tillat uten digest. */
  allowUnpinnedImage?: boolean;
  /** WP-C1: `never` legger `--pull never` på `docker create` (kun lokalt tilgjengelige images; aldri en stille registry-henting). */
  pull?: "never";
}

export interface JobContainerJob {
  containerName: string;
  workdir: string;
  /** Env-NAVN hvis verdier leveres i docker-prosessens egen env (aldri i argv). */
  envNames: readonly string[];
  /** Konstante, IKKE-hemmelige env-verdier (git-identitet m.m.). Eneste env-verdier som står i argv. */
  fixedEnv?: Readonly<Record<string, string>>;
  /** Merkelapp `jarvis.task_id=<id>` på containeren (sporbarhet). */
  taskId?: string;
}

export declare const DIGEST_PINNED_IMAGE: RegExp;
export declare const IMAGE_ID: RegExp;
export declare const NETWORK_NAME: RegExp;
export declare const FORBIDDEN_NETWORKS: ReadonlySet<string>;
export declare const SAFE_PATH: RegExp;
export declare const ENV_NAME: RegExp;
export declare const FORBIDDEN_ENV: RegExp;
export declare const HOST_RUNNER_FORBIDDEN_ENV: RegExp;

export declare class JobContainerConfigError extends Error {
  readonly reason: string;
  constructor(reason: string);
}

export declare function isHostRunnerEnvNameAllowed(name: string): boolean;
export declare function validateJobContainerPolicy(policy: JobContainerPolicy): void;
export declare function buildJobContainerCreateArgs(policy: JobContainerPolicy, job: JobContainerJob): string[];
