import { copyFile, lstat, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { credentialHelperArgs, GIT_CREDENTIAL_TOKEN_ENV } from "./credentials.mjs";
import { RunnerError } from "./errors.mjs";
import { forceRemoveTree } from "./fsutil.mjs";
import { scrubPaths } from "./log.mjs";
import { runProcess } from "./process.mjs";

/**
 * WP-C1: ALL git-kjøring på VERTEN. To harde prinsipper:
 *
 *  1. git-credentialen forlater aldri denne prosessen unntatt som env på ETT git-kall mot github.com + ett eksakt repo
 *     (runnerens egen credential-helper). Den skrives aldri til disk, argv, `.git/config` eller jobb-containeren.
 *  2. git kjøres ALDRI på verten mot en katalog agenten kontrollerer. Agenten (Claude Code) kan skrive `.git/config` og
 *     `.git/hooks` i `/work` - å kjøre `git` der er en klassisk container-escape (`core.fsmonitor`, hooks, `uploadpack.packObjectsHook`,
 *     `core.sshCommand`, `url.*.insteadOf`...). All host-git går mot (a) en runner-eid, privat `base.git` hentet med credential,
 *     og (b) et FERSKT bare-repo (`verify.git`) som kun får objekter via en verifisert git-bundle laget INNE I containeren.
 *
 * Alle kall: `shell:false`, renset env (tom HOME, ingen system/global-config), hooks av, kun tillatt protokoll, ingen submoduler.
 */

const SHA1 = /^[0-9a-f]{40}$/;
export const BASE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const MIN_GIT = [2, 39, 0];

/**
 * Øvre grense (byte) for ÉN oppføring i `git diff-tree -r --raw -z --no-abbrev`-utdata: `:<6> <6> <40> <40> <S>\0` (99 byte) + sti (maks 4096 - lengre nektes uansett) + `\0`.
 * Utdatataket til diff-tree utledes av `max_files` (se `diffOutputCap`), så en diff innenfor grensen ALDRI kan avkortes.
 */
export const DIFF_ENTRY_MAX_BYTES = 99 + 4096 + 1;

/** Forbudte sti-komponenter uavhengig av konfig: `.git` (også NTFS-/HFS-varianter), `.`/`..`. */
function normalizeComponent(component) {
  return component.normalize("NFKC").toLowerCase().replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").replace(/[. ]+$/u, "");
}

/** Sammenligningsform for nektelisten: NFKC, små bokstaver, ingen usynlige tegn, og ingen etterfølgende punktum/mellomrom på noen komponent (Windows ignorerer dem: `.github./x` = `.github/x`). @param {string} p */
function normalizePath(p) {
  return p.normalize("NFKC").toLowerCase().replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").split("/").map((part) => part.replace(/[. ]+$/u, "")).join("/");
}

/**
 * NTFS-kortnavn (8.3) for et punktnavn: `.github` -> `github~1`, `.gitmodules` -> `gitmod~1`, `.gitattributes` -> `gitatt~1`, `.lfsconfig` -> `lfscon~1` (de seks første bokstavene/sifrene + `~N`).
 * På en Windows-sjekkut kan kortnavnet adressere samme oppføring som det lange (derfor har git egne regler for `git~1`). `N` er et hvilket som helst tall (en kollisjon gir `~2`, `~3` ...), og for
 * de navnene git selv beskytter finnes i tillegg et hash-basert kortnavn når fire kortnavn er tatt: `gi7eba~N` = `.gitmodules` (målt mot git 2.43: `update-index` nekter både `gitmod~1..4` og `gi7eba~1..9`
 * som `.gitmodules`), `gi7d29~N` = `.gitattributes` og `gi250a~N` = `.gitignore` (git `path.c`, `is_ntfs_dot_generic`).
 */
const NTFS_HASH_PREFIX = new Map([[".gitmodules", "gi7eba"], [".gitattributes", "gi7d29"], [".gitignore", "gi250a"]]);

/**
 * Mønster for NTFS-kortnavnene til en nektelistekomponent (allerede normalisert), eller `null` hvis komponenten ikke er et punktnavn.
 * @param {string} component
 * @returns {RegExp | null}
 */
function ntfsAliasPattern(component) {
  if (!component.startsWith(".")) return null;
  const stem = component.slice(1).replace(/[^a-z0-9]/g, "").slice(0, 6);
  if (stem.length === 0) return null;
  const hash = NTFS_HASH_PREFIX.get(component);
  return new RegExp(`^(?:${stem}${hash !== undefined ? `|${hash}` : ""})~[0-9]+$`); // `stem`/`hash` har kun [a-z0-9]
}

/**
 * Kompilerer nektelisten ÉN gang (normalisering + kortnavnmønstre). WP-C1 review A-F1: reglene er de samme som i `.gitignore`.
 *  - Oppføring med ÉN komponent (`.gitattributes`, `.gitmodules`, `.lfsconfig`, `.github/`) gjelder på ALLE nivåer: `src/.gitattributes` og `pakke/.github/x` treffes som rotfilene.
 *    (En `.gitattributes` i en undermappe kan skjule en endring for en reviewer, `* -diff`; en `.lfsconfig` kan peke LFS mot en fremmed server.) En avsluttende `/` er kosmetisk.
 *  - Oppføring med en STI (`ci/secrets/`, `infra/prod`) er forankret i repo-roten og dekker alt under.
 * @param {readonly string[]} denyPaths
 */
export function compileDenyPaths(denyPaths) {
  return denyPaths.map((entry) => {
    const components = normalizePath(entry).split("/").filter((c) => c !== "");
    return { entry, anchored: components.length > 1, components, aliases: components.map(ntfsAliasPattern) };
  });
}

/**
 * Treffer stien (normaliserte komponenter) den kompilerte oppføringen? Hver komponent sammenlignes både som skrevet og som NTFS-kortnavn.
 * @param {string[]} pathComponents @param {ReturnType<typeof compileDenyPaths>[number]} compiled
 */
function matchesDenyEntry(pathComponents, compiled) {
  const hit = (/** @type {string | undefined} */ component, /** @type {number} */ index) =>
    component !== undefined && (component === compiled.components[index] || (compiled.aliases[index]?.test(component) ?? false));
  if (compiled.anchored) return pathComponents.length >= compiled.components.length && compiled.components.every((_, index) => hit(pathComponents[index], index));
  return compiled.components.length === 1 && pathComponents.some((component) => hit(component, 0));
}

/**
 * Sjekker én endret sti mot de harde reglene og den konfigurerbare nektelisten. Kaster `RunnerError('path_denied')`.
 * Harde regler (uavhengig av konfig): ingen kontrolltegn/backslash/absolutt sti, ingen tomme/`.`/`..`-komponenter, ingen `.git` (store/små bokstaver, usynlige tegn,
 * etterfølgende punktum/mellomrom, Unicode-kompatibilitetsformer) og ingen NTFS-varianter av den: kortnavnet `git~1` og alternative datastrømmer (enhver komponent med `:`).
 * @param {string} path
 * @param {ReturnType<typeof compileDenyPaths>} denyPaths nekteliste fra `compileDenyPaths` (kompiler én gang per publish, ikke per sti)
 */
export function assertPathAllowedCompiled(path, denyPaths) {
  // eslint-disable-next-line no-control-regex
  if (path.length === 0 || path.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith("/")) {
    throw new RunnerError("path_denied", 422, "path_invalid");
  }
  for (const component of path.split("/")) {
    const c = normalizeComponent(component);
    if (component === "" || component === "." || component === ".." || c === ".git" || c === "") {
      throw new RunnerError("path_denied", 422, "path_component_forbidden");
    }
    if (/^git~[0-9]+$/.test(c) || component.includes(":")) throw new RunnerError("path_denied", 422, "path_component_forbidden");
  }
  const components = normalizePath(path).split("/");
  for (const entry of denyPaths) {
    if (matchesDenyEntry(components, entry)) throw new RunnerError("path_denied", 422, `matches_deny_list:${entry.entry.slice(0, 40)}`);
  }
}

/** @param {string} path @param {readonly string[]} denyPaths rå nekteliste (kompileres her; `verifyAndPush` bruker `assertPathAllowedCompiled`) */
export function assertPathAllowed(path, denyPaths) {
  assertPathAllowedCompiled(path, compileDenyPaths(denyPaths));
}

/**
 * Parser `git diff-tree -r --raw -z --no-renames`-utdata. Kaster ved ethvert format vi ikke kjenner igjen.
 * @param {Buffer} stdout
 * @returns {Array<{ oldMode: string, newMode: string, status: string, path: string }>}
 */
export function parseRawDiff(stdout) {
  const parts = stdout.toString("utf8").split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length % 2 !== 0) throw new RunnerError("diff_unparseable", 422);
  const entries = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} ([ADMT])$/.exec(parts[i] ?? "");
    const path = parts[i + 1];
    if (!m || path === undefined) throw new RunnerError("diff_unparseable", 422);
    entries.push({ oldMode: /** @type {string} */ (m[1]), newMode: /** @type {string} */ (m[2]), status: /** @type {string} */ (m[3]), path });
  }
  return entries;
}

/**
 * Parser en v2 git-bundle-header STRENGT (vi stoler ikke på bundlen: den er laget av en agent-kontrollert git). Returnerer
 * prerequisites, refs og hvor pakken starter. Alt utenfor formatet avvises.
 * @param {Buffer} buf
 */
export function parseBundleHeader(buf) {
  const signature = Buffer.from("# v2 git bundle\n");
  const invalid = (reason) => new RunnerError("bundle_invalid", 422, reason);
  if (buf.length < signature.length || !buf.subarray(0, signature.length).equals(signature)) throw invalid("bad_signature");
  let pos = signature.length;
  /** @type {string[]} */ const prerequisites = [];
  /** @type {Array<{ sha: string, name: string }>} */ const refs = [];
  for (;;) {
    if (pos >= buf.length || pos > 65_536) throw invalid("header_truncated");
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0 || nl - pos > 4_096) throw invalid("header_line_invalid");
    const line = buf.subarray(pos, nl).toString("latin1");
    pos = nl + 1;
    if (line === "") break;
    const pre = /^-([0-9a-f]{40})(?: [^\n]*)?$/.exec(line);
    const ref = /^([0-9a-f]{40}) ([A-Za-z0-9._/-]{1,200})$/.exec(line);
    if (pre) prerequisites.push(/** @type {string} */ (pre[1]));
    else if (ref) refs.push({ sha: /** @type {string} */ (ref[1]), name: /** @type {string} */ (ref[2]) });
    else throw invalid("header_line_unrecognized");
    if (prerequisites.length + refs.length > 64) throw invalid("header_too_many_entries");
  }
  if (buf.length < pos + 4 || buf.subarray(pos, pos + 4).toString("latin1") !== "PACK") throw invalid("pack_signature_missing");
  return { prerequisites, refs, packOffset: pos };
}

/** `git version 2.43.0` / `git version 2.39.5 (Apple Git-154)` -> [2, 43, 0] */
export function parseGitVersion(text) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export class HostGit {
  /**
   * @param {{
   *   gitBin: string, nodePath: string, helperScript: string, homeDir: string, templateDir: string,
   *   remote: { protocol: "https" | "http", host: string, urlFor?: (slug: string) => string },
   *   allowFile?: boolean,
   *   run?: typeof runProcess,
   *   registry: import("./log.mjs").SecretRegistry,
   *   scrub?: ReadonlyArray<readonly [string, string]>,
   *   diffEntryBytes?: number
   * }} options
   */
  constructor(options) {
    this.gitBin = options.gitBin;
    this.nodePath = options.nodePath;
    this.helperScript = options.helperScript;
    this.homeDir = options.homeDir;
    this.templateDir = options.templateDir;
    this.remote = options.remote;
    this.allowFile = options.allowFile === true;
    this.run = options.run ?? runProcess;
    this.registry = options.registry;
    /** Interne stier som aldri skal stå i en feildetalj til klienten (jobbkatalogen m.m.). */
    this.scrub = options.scrub ?? [];
    /** Byte per diff-tree-oppføring som utdatataket regnes med (KUN tester senker den, for å kunne avkorte uten 8 MiB; produksjon bruker alltid DIFF_ENTRY_MAX_BYTES). */
    this.diffEntryBytes = options.diffEntryBytes ?? DIFF_ENTRY_MAX_BYTES;
  }

  /** Renset basis-env: tom HOME, ingen system/global-config, ingen prompt, kun den ene tillatte protokollen. */
  env(extra = {}) {
    const allowed = [this.remote.protocol, ...(this.allowFile ? ["file"] : [])];
    return {
      PATH: "/usr/bin:/bin",
      HOME: this.homeDir,
      XDG_CONFIG_HOME: this.homeDir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: allowed.join(":"),
      GIT_TEMPLATE_DIR: this.templateDir,
      LC_ALL: "C",
      LANG: "C",
      ...extra
    };
  }

  /** `-c`-hardening foran HVERT nettverkskall (git-config via `-c` har høyest presedens). */
  hardeningArgs() {
    return [
      "-c", "core.hooksPath=/dev/null",
      "-c", "protocol.ext.allow=never",
      "-c", "protocol.allow=never",
      "-c", `protocol.${this.remote.protocol}.allow=always`,
      ...(this.allowFile ? ["-c", "protocol.file.allow=always"] : []),
      "-c", "http.followRedirects=false",
      "-c", "core.fsmonitor=false",
      "-c", "transfer.fsckObjects=true",
      "-c", "submodule.recurse=false",
      "-c", "gc.auto=0"
    ];
  }

  /** @param {string} slug */
  remoteUrl(slug) {
    if (this.remote.urlFor) return this.remote.urlFor(slug);
    return `${this.remote.protocol}://${this.remote.host}/${slug}.git`;
  }

  /** Kort, renset feildetalj fra git (aldri hemmeligheter; kuttet). */
  sanitize(result) {
    const text = `${result.stderr.toString("utf8")} ${result.stdout.toString("utf8")}`.replace(/\s+/g, " ").trim();
    return scrubPaths(this.registry.redact(text), this.scrub).slice(0, 200);
  }

  /**
   * @param {string[]} args
   * @param {{ cwd?: string, env?: Record<string, string>, timeoutMs?: number, cancel?: import("./errors.mjs").CancelToken, input?: Buffer | string, maxOutputBytes?: number }} [options]
   */
  async git(args, options = {}) {
    return this.run(this.gitBin, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: this.env(options.env ?? {}),
      timeoutMs: options.timeoutMs ?? 60_000,
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
      ...(options.cancel ? { cancel: options.cancel } : {}),
      ...(options.input !== undefined ? { input: options.input } : {})
    });
  }

  /**
   * Som `git()`, men kaster `RunnerError(code)` ved feil/tidsavbrudd/avbrudd. WP-C1 review A-F2: AVKORTET utdata (taket `maxOutputBytes` nådd) er aldri «komplett»: alt som leses
   * av `mustGit` er enten parset (diff-tree, rev-list, ls-remote ...) eller bevis på at noe gikk bra, og en avkortet liste hadde latt stier etter kuttpunktet slippe unna
   * nekteliste og tellere. Kaster derfor `git_output_truncated` (stabil kode; detaljen er trinnets kode) uavhengig av hvilket trinn det er.
   * @param {string[]} args
   * @param {Parameters<HostGit["git"]>[1]} options
   * @param {string} code
   * @param {number} [status]
   */
  async mustGit(args, options, code, status = 502) {
    const result = await this.git(args, options);
    if (result.cancelled) throw new RunnerError("job_cancelled", 409);
    if (result.timedOut) throw new RunnerError(`${code}_timeout`, 504);
    if (result.spawnError !== undefined) throw new RunnerError(`${code}`, 500, "git_could_not_start");
    if (result.status !== 0) throw new RunnerError(code, status, this.sanitize(result));
    if (result.truncated) throw new RunnerError("git_output_truncated", status, code);
    return result;
  }

  /**
   * Kaller git med credential-helperen scopet til nøyaktig dette repoet. Token leveres KUN som env til dette ene kallet. Tokenet er registrert som
   * hemmelighet (redigeres fra feildetaljer og logg) KUN mens kallet pågår: kortlevde tokens (ett nytt per kall) skal ikke hope seg opp i registeret.
   */
  async netGit(args, { slug, token, cwd, timeoutMs, cancel, env }) {
    const helper = credentialHelperArgs({
      nodePath: this.nodePath,
      helperScript: this.helperScript,
      scope: { protocol: this.remote.protocol, host: this.remote.host, path: slug }
    });
    const release = this.registry.hold(token);
    try {
      return await this.mustGit([...this.hardeningArgs(), ...helper, ...args], {
        env: { ...(env ?? {}), [GIT_CREDENTIAL_TOKEN_ENV]: token },
        ...(cwd !== undefined ? { cwd } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(cancel ? { cancel } : {})
      }, "git_network_failed");
    } finally {
      release();
    }
  }

  async assertVersion() {
    const result = await this.git(["--version"], { timeoutMs: 10_000 });
    const v = parseGitVersion(result.stdout.toString("utf8"));
    if (!v || v[0] < MIN_GIT[0] || (v[0] === MIN_GIT[0] && v[1] < MIN_GIT[1])) {
      throw new RunnerError("git_too_old", 500, `need>=${MIN_GIT.join(".")}`);
    }
    return v.join(".");
  }

  /**
   * Henter basen i et runner-eid, privat BARE-repo (`base.git`) med credential. Bruker `init`+`fetch` (ikke `clone`): `-c`-verdier
   * persisteres dermed aldri i repoets config, og ingen credential-konfigurasjon blir liggende igjen.
   *
   * @param {{ slug: string, baseBranch?: string, depth: number, baseGitDir: string, token: string, timeoutMs: number, cancel?: import("./errors.mjs").CancelToken }} p
   */
  async fetchBase(p) {
    const url = this.remoteUrl(p.slug);
    await this.mustGit(["init", "--bare", "--quiet", p.baseGitDir], { timeoutMs: 30_000, ...(p.cancel ? { cancel: p.cancel } : {}) }, "git_init_failed", 500);
    let branch = p.baseBranch;
    if (branch === undefined) {
      const ls = await this.netGit(["ls-remote", "--symref", url, "HEAD"], { slug: p.slug, token: p.token, timeoutMs: 60_000, ...(p.cancel ? { cancel: p.cancel } : {}) });
      const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(ls.stdout.toString("utf8"));
      branch = m?.[1];
      if (branch === undefined || !BASE_BRANCH.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".lock")) {
        throw new RunnerError("base_branch_unresolvable", 502);
      }
    }
    const refspec = `+refs/heads/${branch}:refs/heads/${branch}`;
    await this.netGit(
      ["fetch", "--quiet", "--no-tags", ...(p.depth > 0 ? [`--depth=${p.depth}`] : []), url, refspec],
      { slug: p.slug, token: p.token, cwd: p.baseGitDir, timeoutMs: p.timeoutMs, ...(p.cancel ? { cancel: p.cancel } : {}) }
    );
    await this.mustGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: p.baseGitDir, timeoutMs: 15_000 }, "git_refs_failed", 500);
    const rev = await this.mustGit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd: p.baseGitDir, timeoutMs: 15_000 }, "git_refs_failed", 500);
    const baseSha = rev.stdout.toString("utf8").trim();
    if (!SHA1.test(baseSha)) throw new RunnerError("git_refs_failed", 500);
    return { branch, baseSha };
  }

  /**
   * Lager arbeidskopien som monteres som `/work`: lokal klone fra det private `base.git` (ingen credential trengs, ingen
   * hardlenker mot det private repoet), uten hooks/maler, og UTEN noen remote - agenten har verken nettverk eller credential.
   * Kjøres FØR containeren starter, mot ferskt innhold fra runnerens eget repo.
   *
   * @param {{ baseGitDir: string, workDir: string, branch: string, cwd: string, timeoutMs: number, cancel?: import("./errors.mjs").CancelToken }} p
   */
  async createWorkCheckout(p) {
    await mkdir(p.workDir, { mode: 0o700 });
    const localEnv = {
      GIT_ALLOW_PROTOCOL: "file",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "protocol.file.allow", GIT_CONFIG_VALUE_2: "always",
      GIT_CONFIG_KEY_3: "advice.detachedHead", GIT_CONFIG_VALUE_3: "false"
    };
    await this.mustGit(
      ["clone", "--quiet", "--no-hardlinks", "--no-tags", "--single-branch", "--branch", p.branch, `--template=${this.templateDir}`, "--", p.baseGitDir, p.workDir],
      { cwd: p.cwd, env: localEnv, timeoutMs: p.timeoutMs, ...(p.cancel ? { cancel: p.cancel } : {}) },
      "git_checkout_failed"
    );
    // Fjern origin (peker på et runner-privat filsystem-sti): agenten skal ikke se hvor basen ligger og har uansett ingen remote å bruke.
    await this.mustGit(["-C", p.workDir, "remote", "remove", "origin"], { cwd: p.cwd, env: localEnv, timeoutMs: 15_000 }, "git_checkout_failed", 500);
  }

  /**
   * Verifiserer en agent-laget git-bundle og pusher KUN den verifiserte committen til `refs/heads/<branch>`.
   * Rekkefølge (hvert trinn feiler lukket, og INGEN git kjøres mot agentens katalog):
   *   1. streng header-parsing (nøyaktig én ref `HEAD`, nøyaktig én prerequisite = basen, `PACK`-signatur),
   *   2. ferskt bare-repo (`verify.git`) som låner basens objekter via `alternates` (+ `shallow`),
   *   3. `git fetch <bundle> HEAD:refs/jarvis/candidate`, `git fsck --strict` (fetch fsck-er IKKE bundler - målt),
   *   4. SHA = headerens, etterkommer av basen, lineær (ingen merge-commits), <= maks commits,
   *   5. endrede stier mot harde regler + nekteliste, ingen submodul-endringer, <= maks filer,
   *   6. `git push <url> <sha>:refs/heads/<branch>` uten force/sletting, med runnerens credential.
   *
   * @param {{
   *   bundle: Buffer, baseSha: string, baseGitDir: string, verifyDir: string, privateDir: string, slug: string, branch: string,
   *   limits: { maxCommits: number, maxFiles: number, denyPaths: readonly string[] },
   *   timeoutMs: number, token: string, cancel?: import("./errors.mjs").CancelToken
   * }} p
   */
  async verifyAndPush(p) {
    const header = parseBundleHeader(p.bundle);
    if (header.refs.length !== 1 || header.refs[0]?.name !== "HEAD") throw new RunnerError("bundle_invalid", 422, "must_contain_exactly_one_ref_HEAD");
    if (header.prerequisites.length !== 1 || header.prerequisites[0] !== p.baseSha) throw new RunnerError("bundle_invalid", 422, "prerequisite_must_be_the_base_commit");
    const headerSha = /** @type {string} */ (header.refs[0]?.sha);

    const bundlePath = join(p.privateDir, "out.bundle");
    // Fjern en gammel (eller plantet) oppføring først - en symlenke fjernes, aldri følges - og opprett deretter eksklusivt (`wx`): runneren skriver aldri GJENNOM en lenke.
    await forceRemoveTree(bundlePath).catch(() => undefined);
    await writeFile(bundlePath, p.bundle, { mode: 0o600, flag: "wx" });
    await forceRemoveTree(p.verifyDir).catch(() => undefined);
    await this.mustGit(["init", "--bare", "--quiet", p.verifyDir], { timeoutMs: 30_000, ...(p.cancel ? { cancel: p.cancel } : {}) }, "git_init_failed", 500);
    await writeFile(join(p.verifyDir, "objects", "info", "alternates"), `${join(p.baseGitDir, "objects")}\n`, { mode: 0o600 });
    const shallow = join(p.baseGitDir, "shallow");
    if (await stat(shallow).then(() => true, () => false)) await copyFile(shallow, join(p.verifyDir, "shallow"));

    const inRepo = { cwd: p.verifyDir, env: { GIT_DIR: p.verifyDir }, ...(p.cancel ? { cancel: p.cancel } : {}) };
    const hardened = (args) => ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", ...args];

    // En bundle-fil regnes av git som `file`-transport. `file` åpnes KUN for dette ene lokale kallet (en runner-skrevet vanlig fil i
    // privat katalog) - aldri for nettverkskallene, som kun har den ene tillatte protokollen.
    const bundleSt = await lstat(bundlePath);
    if (!bundleSt.isFile() || bundleSt.isSymbolicLink()) throw new RunnerError("bundle_invalid", 422, "bundle_path_not_a_regular_file");
    await this.mustGit(
      hardened(["-c", "protocol.file.allow=always", "fetch", "--quiet", "--no-tags", bundlePath, "HEAD:refs/jarvis/candidate"]),
      { ...inRepo, env: { ...inRepo.env, GIT_ALLOW_PROTOCOL: "file" }, timeoutMs: p.timeoutMs },
      "bundle_fetch_failed", 422
    );
    await this.mustGit(hardened(["fsck", "--strict", "--no-dangling", "--no-progress"]), { ...inRepo, timeoutMs: p.timeoutMs }, "bundle_fsck_failed", 422);

    const rev = await this.mustGit(hardened(["rev-parse", "--verify", "refs/jarvis/candidate^{commit}"]), { ...inRepo, timeoutMs: 15_000 }, "bundle_invalid", 422);
    const sha = rev.stdout.toString("utf8").trim();
    if (sha !== headerSha || !SHA1.test(sha)) throw new RunnerError("bundle_invalid", 422, "head_does_not_match_header");

    const ancestor = await this.git(hardened(["merge-base", "--is-ancestor", p.baseSha, sha]), { ...inRepo, timeoutMs: 15_000 });
    if (ancestor.status !== 0) throw new RunnerError("bundle_invalid", 422, "not_a_descendant_of_the_base");

    const count = await this.mustGit(hardened(["rev-list", "--count", `${p.baseSha}..${sha}`]), { ...inRepo, timeoutMs: 30_000 }, "bundle_invalid", 422);
    const commits = Number(count.stdout.toString("utf8").trim());
    if (!Number.isInteger(commits) || commits < 1) throw new RunnerError("no_changes", 422, "no_commits_beyond_the_base");
    if (commits > p.limits.maxCommits) throw new RunnerError("bundle_too_many_commits", 422, `max=${p.limits.maxCommits}`);
    const merges = await this.mustGit(hardened(["rev-list", "--merges", "--count", `${p.baseSha}..${sha}`]), { ...inRepo, timeoutMs: 30_000 }, "bundle_invalid", 422);
    if (Number(merges.stdout.toString("utf8").trim()) !== 0) throw new RunnerError("bundle_invalid", 422, "merge_commits_not_allowed");

    // Utdatataket utledes av `max_files` (maks `max_files + 1` oppføringer à maks DIFF_ENTRY_MAX_BYTES): en diff innenfor grensen kan aldri avkortes, og en avkortet diff (flere filer enn
    // grensen, eller absurd lange stier) feiler lukket - uten dette kunne stier etter kuttpunktet (f.eks. `.github/workflows/x.yml`) aldri blitt sjekket mot nektelisten (A-F2).
    let diff;
    try {
      diff = await this.mustGit(
        hardened(["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", "--no-textconv", "--no-ext-diff", p.baseSha, sha]),
        { ...inRepo, timeoutMs: 60_000, maxOutputBytes: (p.limits.maxFiles + 1) * this.diffEntryBytes + 1 },
        "bundle_invalid", 422
      );
    } catch (error) {
      if (error instanceof RunnerError && error.code === "git_output_truncated") throw new RunnerError("bundle_too_many_files", 422, `max=${p.limits.maxFiles};diff_output_truncated`);
      throw error;
    }
    const entries = parseRawDiff(diff.stdout);
    if (entries.length === 0) throw new RunnerError("no_changes", 422, "tree_identical_to_the_base");
    if (entries.length > p.limits.maxFiles) throw new RunnerError("bundle_too_many_files", 422, `max=${p.limits.maxFiles}`);
    const denyPaths = compileDenyPaths(p.limits.denyPaths);
    for (const entry of entries) {
      if (entry.oldMode === "160000" || entry.newMode === "160000") throw new RunnerError("path_denied", 422, "submodule_changes_not_allowed");
      assertPathAllowedCompiled(entry.path, denyPaths);
    }

    // Push: kun den verifiserte SHA-en, kun mot refs/heads/<prefiks>..., aldri force/sletting (refspec har ingen `+` og ingen tom kilde).
    const url = this.remoteUrl(p.slug);
    const pushed = await this.netGit(
      ["push", "--porcelain", "--no-verify", "--no-follow-tags", url, `${sha}:refs/heads/${p.branch}`],
      { slug: p.slug, token: p.token, cwd: p.verifyDir, env: { GIT_DIR: p.verifyDir }, timeoutMs: p.timeoutMs, ...(p.cancel ? { cancel: p.cancel } : {}) }
    ).catch((error) => {
      // `git push` med avvist ref gir exit 1 og en renset detalj; behold koden men vis tydelig at dette var push-steget.
      if (error instanceof RunnerError && error.code === "git_network_failed") throw new RunnerError("push_failed", 502, error.detail);
      throw error;
    });
    const lines = pushed.stdout.toString("utf8").split("\n");
    const refLine = lines.find((l) => l.includes(`:refs/heads/${p.branch}`));
    if (!refLine || /^[!+-]/.test(refLine)) throw new RunnerError("push_rejected", 502, refLine?.slice(0, 120));
    return { commitSha: sha, baseSha: p.baseSha, commits, filesChanged: entries.length };
  }
}
