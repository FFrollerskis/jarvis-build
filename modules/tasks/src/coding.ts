import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { GitCredentialSource, IdentityContext } from "@jarvis/contracts";
import { scanForSecrets, withTenantTransaction } from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";
import { createGitAuthHandle, GIT_CREDENTIAL_ISOLATION_ARGS, githubCredentialScope } from "./git-auth.ts";
import {
  GIT_HARDENING_ARGS, GIT_LOCAL_HARDENING_ARGS, GitPolicyError, assertJobBranch, assertRepoAllowed, assertTestCommand
} from "./git-policy.ts";
import { publishPullRequestForCodingJob, type PrPublishingGateway } from "./pr-publisher.ts";
import type { ExecResult, SandboxRunner } from "./sandbox.ts";
import type { TaskHandler } from "./worker.ts";

/** Kodejobb-eksekutør slik sandboxen faktisk eksponerer den (samme signatur som `Sandbox.exec`). */
export type CodingAgentExec = (cmd: string, args: string[], timeoutMs?: number) => ExecResult | Promise<ExecResult>;

/** Kodeagent bak adapter: skriptet i test; Claude Code headless når binær/nøkkel finnes. */
export interface CodingAgentAdapter {
  readonly name: string;
  /** Gjør endringen i workdir; returnerer beskrivelse av hva som ble gjort. */
  modify(workdirExec: CodingAgentExec, goal: string): Promise<string>;
}

export class ScriptedCodingAgent implements CodingAgentAdapter {
  readonly name = "scripted-agent";
  async modify(exec: CodingAgentExec, goal: string): Promise<string> {
    const content = `# Endring utført av jarvis-worker\n\nMål: ${goal}\n`;
    const escaped = content.replace(/\n/g, "\\n").replace(/"/g, '\\"');
    await exec("node", ["-e", `require('fs').writeFileSync('CHANGES.md', "${escaped}")`]);
    return "La til CHANGES.md med målbeskrivelse";
  }
}

/**
 * D-96 Real Coding Agent v1: ekte, ikke-interaktiv Claude Code CLI-kjøring
 * (JARVIS_CLAUDE_BIN), INNE i den eksisterende jobb-sandboxen (samme `exec`
 * som resten av kodejobben - ingen egen/ny sandbox). Verifisert MOT
 * offisiell dokumentasjon (https://code.claude.com/docs/en/headless,
 * 2026-08-20), ikke antatt:
 *
 * - `-p "<mål>"` = ikke-interaktiv engangs-kjøring (dokumentert oppførsel).
 * - `--bare` = hopper over hook/plugin/CLAUDE.md-oppdagelse - PÅKREVD her:
 *   uten `--bare` forventer `-p` interaktiv OAuth/nøkkelring-innlogging, som
 *   en engangs, tom sandbox strukturelt ALDRI har tilgang til (ingen
 *   vedvarende `~/.claude`-tilstand følger med en kastbar jobb-sandbox).
 *   Med `--bare` autentiseres CLI-en KUN via `ANTHROPIC_API_KEY` i prosess-
 *   env - injisert EKSPLISITT (se `createCodingHandler`s `claudeCodeCredential`),
 *   ALDRI arvet fra Jarvis-prosessen (samme "ren env"-prinsipp som resten av
 *   sandboxen).
 * - `--permission-mode acceptEdits` = filredigering skjer uten et (umulig,
 *   ubetjent) godkjenningsprompt.
 * - `--allowedTools "Read,Edit"` - BEVISST IKKE "Bash": agenten skal KUN
 *   foreslå en diff. Den EKSISTERENDE test-porten i `createCodingHandler`
 *   kjører den ekte testkommandoen PÅ NYTT etterpå, uendret - agenten kan
 *   ALDRI selv erklære "testene består" (jf. Q-26).
 * - `--output-format json` = strukturert `{result: "<tekst>"}`-utgang.
 * - Suksess/feil avgjøres UTELUKKENDE av prosessens exit-kode (dokumentert
 *   kontrakt: 0 = suksess, ikke-null = feil) - ALDRI av å tolke fritekst.
 *
 * Persisterer KUN en kort, strukturert beskrivelse (CLI-ens `result`-felt) -
 * ALDRI en skjult resonnerings-logg (Q-26/§13: ingen chain-of-thought lagres).
 */
export class ClaudeCodeAgent implements CodingAgentAdapter {
  readonly name = "claude-code";
  constructor(
    private readonly bin: string | undefined = process.env["JARVIS_CLAUDE_BIN"],
    private readonly timeoutMs = 300_000
  ) {}

  async modify(exec: CodingAgentExec, goal: string): Promise<string> {
    if (!this.bin) {
      throw new Error("claude_code_not_configured");
    }
    const args = [
      "-p", goal,
      "--bare",
      "--output-format", "json",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Edit"
    ];
    const result = await exec(this.bin, args, this.timeoutMs);
    if (result.code !== 0) {
      throw new Error(`claude_code_cli_failed:${(result.stderr || result.stdout || "").slice(0, 300)}`);
    }
    const description = parseClaudeCodeCliResult(result.stdout);
    if (!description) {
      throw new Error(`claude_code_cli_invalid_output:${result.stdout.slice(0, 300)}`);
    }
    return description;
  }
}

/** `--output-format json` sitt `result`-felt; faller tilbake til rå stdout kun hvis JSON-parsing feiler (ALDRI hvis den lykkes men `result` mangler/er tom - det er en reell, rapporterbar feil). */
function parseClaudeCodeCliResult(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    return typeof parsed.result === "string" && parsed.result.length > 0 ? parsed.result : null;
  } catch {
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

export class ArtifactStore {
  constructor(private readonly pool: pg.Pool) {}
  async save(tenantId: string, taskId: string, kind: string, name: string, content: string): Promise<void> {
    await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `INSERT INTO artifacts (artifact_id, task_id, tenant_id, kind, name, content)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        // D-394 (JARVIS-069): artefakter (testlogger, diff) er fritekst fra en agent/prosess og kan inneholde hemmeligheter - redigeres FØR lagring.
        [`art-${randomUUID()}`, taskId, tenantId, kind, name, scanForSecrets(content.slice(0, 100_000)).text]
      )
    );
  }
  async list(tenantId: string, taskId: string): Promise<Array<{ kind: string; name: string; content: string }>> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query("SELECT kind, name, content FROM artifacts WHERE task_id = $1 ORDER BY created_at", [taskId])
    );
    return result.rows as Array<{ kind: string; name: string; content: string }>;
  }
}

const PROTECTED_BRANCHES = new Set(["main", "master", "production"]);

/**
 * D-101: kastet i stedet for å tvinge frem `git add`/`git commit` når agenten
 * ikke gjorde noen endring i det hele tatt. FØR denne reparasjonen forsøkte
 * `createCodingHandler` UBETINGET `git add -A` + `git commit` selv naar
 * arbeidstreet var helt uendret - `git commit` feiler da med "nothing to
 * commit" (skrevet til STDOUT, ikke stderr - samme feilklasse som D-99s
 * opprinnelige `seedFixtureRepo`-bug, men her i selve PRODUKSJONShandleren),
 * som `must("commit", ...)` fanget som en tom, ugjennomsiktig
 * `commit_failed: `-feil - et EKTE, uavhengig live-evalueringsfunn (D-101,
 * Task C: agenten korrekt og ærlig avsto fra å gjette en verdi den ikke
 * hadde grunnlag for, jf. Task C sin `honest_failure`-fixture i
 * `coding-agent-eval.ts`) klassifiserte dette feilaktig som en harness-
 * PERSISTENS-feil i stedet for hva det faktisk var: et strukturelt KORREKT
 * "agenten fant ingen fiks å gjøre"-utfall. Denne eksporterte, stabile
 * etiketten (ALDRI pakket i `must()`s "<label>_failed:"-konvensjon) lar
 * evalueringslaget (`coding-agent-eval.ts`) skille dette presist fra en ekte
 * git-/harness-mekanikk-feil - se `classifyFailureCategory()`.
 *
 * VIKTIG (§9 i D-101-ordren): jobben MARKERES FORTSATT SOM FEILET (aldri
 * "completed") naar dette skjer - en produksjonskodejobb som forventet en
 * ekte fiks skal ALDRI stille fremstå som vellykket bare fordi ingen endring
 * ble gjort. Denne reparasjonen endrer KUN hvilken (ærlig, presis) feil som
 * kastes - ALDRI om jobben lykkes.
 */
export const NO_CHANGES_TO_COMMIT_LABEL = "no_changes_to_commit";

/**
 * Kodejobb-handler: sandbox → clone → branch → agentendring → tester →
 * commit → push av JOBB-BRANCH (aldri beskyttet branch) → artefakter
 * (patch, testlogg, PR-forslag). PR-opprettelse mot GitHub krever API-tilgang
 * og er et artefakt/forslag her; merge er ALLTID menneskelig gate.
 * Push krever klasse C-mandat i Policy Gateway ("git:push_branch").
 */
export function createCodingHandler(deps: {
  sandbox: SandboxRunner;
  agent: CodingAgentAdapter;
  artifacts: ArtifactStore;
  policy: PolicyGateway;
  identityFor: (task: { tenant_id: string; contract: { owner_person_id: string } }) => IdentityContext;
  /**
   * UA-5 Tested Fix Orchestrator v1 (D-95, valgfritt): når satt, forsøker
   * en vellykket kodejobb å åpne en EKTE GitHub-PR for jobb-branchen (via
   * eksisterende `github.create_pr`, klasse C) - KUN når jobbkontrakten selv
   * lister "github" i allowed_tools. Uten dette feltet er oppførselen
   * UENDRET (kun det lokale pr-proposal-artefaktet, som før D-95).
   */
  github?: { gateway: PrPublishingGateway; base?: string };
  /**
   * D-96 Real Coding Agent v1 (valgfritt): credential som injiseres i
   * sandboxens prosess-env (aldri arvet fra Jarvis-prosessen) - KUN når
   * `agent` faktisk trenger en (f.eks. `ClaudeCodeAgent` sin
   * `ANTHROPIC_API_KEY` for `--bare`-autentisering). Duck-typed mot
   * `SecretProvider` (samme mønster som `PrPublishingGateway` - ingen
   * pakkeavhengighet til `@jarvis/tool-gateway`). Uten dette feltet er
   * sandbox-oppførselen 100% uendret (tom jobEnv, som før D-96).
   */
  claudeCodeCredential?: { secretProvider: { get(ref: string): Promise<string | null> }; ref?: string };
  /**
   * D-103 (Blokker B, valgfritt): eksplisitt git-transport-credential for
   * `git clone`/`git push` mot en ekte `https://github.com/...`-remote - HELT
   * ATSKILT fra `claudeCodeCredential` (default-referanse `JARVIS_GITHUB_TOKEN`,
   * ALDRI `ANTHROPIC_API_KEY`). Når satt: mangler den refererte secreten,
   * feiler jobben FØR clone forsøkes (`git_auth_unavailable`) - ALDRI et
   * stille fall til uautentisert/ambient-vert-avhengig git. Uten dette feltet
   * (default) er sandbox-git-oppførselen 100% uendret fra før D-103 (lokale
   * bare-repo-tester som ikke trenger nettverksautentisering).
   */
  gitAuth?: {
    secretProvider: { get(ref: string): Promise<string | null> };
    /** Credential-refen (standard `JARVIS_GITHUB_TOKEN`): nøkkelen `secretProvider.get(ref)` leser, og refen `isRevoked(ref)` sjekkes mot. Med `credentialSource` brukes den KUN til tilbakekallingssjekken. */
    ref?: string;
    /**
     * WP-C3 (review F2/F13): kortlevd, REPO-SCOPET git-credential - `tokenFor(<repoet DENNE jobben gjelder>)`, med minste rettighet for clone + push av jobb-branchen. Når den er satt, brukes den i
     * stedet for `secretProvider` (som da ikke leses), og tokenet hentes RETT FØR hver git-nettverksoperasjon (clone og push) i stedet for én gang ved jobbstart: et installasjonstoken lever
     * 1 time, og en jobb kan bruke lengre tid mellom clone og push enn det. Uten feltet er oppførselen uendret (`secretProvider.get(ref)`, men også da hentet på nytt før hver operasjon).
     * Feiler utstedelsen, feiler jobben LUKKET (`git_auth_unavailable[:KODE]`) - aldri et bredere token, aldri uautentisert git.
     */
    credentialSource?: GitCredentialSource;
    /**
     * WP-C3 (review F3): per-credential tilbakekalling (`owner_controls.revoke_credential` på `ref`, delt via `owner_control_state`). Sjekkes FØR hver utstedelse (jobbstart, clone, push); `true`
     * stopper jobben (`git_auth_revoked`) uten at noe token utstedes. En sjekk som selv feiler regnes som «ikke bevist ikke-tilbakekalt» og stopper også (`git_auth_revocation_check_failed`).
     * Kill switch/frys/policy dekkes av `policy.authorize`, som nå kjøres på nytt rett før push.
     */
    isRevoked?: (ref: string) => Promise<boolean>;
  };
  /**
   * Remediering del 2 (JARVIS-064): eksakt allowlist av `owner/repo` (små bokstaver) git-credentialen kan brukes mot.
   * PÅKREVD når `gitAuth` er satt - tom/manglende liste feiler lukket (`git_repo_allowlist_empty`). `repo_url` må være
   * eksakt `https://github.com/<owner>/<repo>`; credentialen utleveres kun til github.com + dette ene repoet.
   */
  allowedRepos?: readonly string[];
}): TaskHandler {
  return async (task, ctx) => {
    const input = task.contract.input.data as { repo_url?: string; test_command?: string[] };
    if (!input.repo_url) {
      throw new Error("coding_job_missing_repo_url");
    }
    const branch = `jarvis/${task.task_id}`;
    if (PROTECTED_BRANCHES.has(branch)) {
      throw new Error("protected_branch_refused");
    }
    // WP-C1 (D-32 / Q-45a): en runner med `hostGit` (vertsside job-runner) eier git-transporten. Da henter vi ALDRI noe git-token, sender
    // ingen credential-env, og clone/push skjer HOS runneren med dens egen credential. Alt øvrig (validering, policy, agent, test, commit)
    // er uendret. Uten `hostGit` er hele flyten byte-for-byte som før.
    const hostGit = deps.sandbox.hostGit === true;
    // Remediering del 2 (JARVIS-009/063/064): all jobb-input valideres i kode FØR policy/credential/sandbox.
    let cloneUrl: string;
    let credentialSlug: string | undefined;
    let testCmd: string[];
    // WP-K (D-471, JARVIS-068): hva `tests: "passed"` faktisk hviler på. `contract_command` = en kontraktstyrt, validert testløper kjørte; `internal_default_noop` = ingen testkommando ble oppgitt, så Jarvis' interne
    // standard (en kommando som alltid består) kjørte - «passed» betyr da KUN at kommandoen avsluttet 0, ikke at noe ble testet. Feltet endrer ingen oppførsel; det gjør en tom «passed» gjenkjennelig.
    let testsBasis: "contract_command" | "internal_default_noop";
    try {
      assertJobBranch(branch);
      if (deps.gitAuth || hostGit) {
        // Med credential (eller vertsside git): kun eksakt `https://github.com/<allowlistet owner/repo>` - aldri en fremmed vert/transport.
        const ref = assertRepoAllowed(input.repo_url, deps.allowedRepos ?? []);
        cloneUrl = ref.canonicalUrl;
        credentialSlug = ref.slug;
      } else {
        // Uten credential (lokale/test-repoer): ingen option-injeksjon (`--upload-pack=...`) og ingen `ext::`-transport.
        // eslint-disable-next-line no-control-regex
        if (input.repo_url.startsWith("-") || /^ext::/i.test(input.repo_url) || /[\u0000-\u001f]/.test(input.repo_url)) {
          throw new GitPolicyError("repo_url_invalid");
        }
        cloneUrl = input.repo_url;
      }
      const requested = input.test_command;
      // Ingen/tom testkommando = Jarvis' EGEN interne standard (ikke kontraktstyrt). Alt kontraktstyrt må være en kjent testløper.
      const explicitTestCommand = Array.isArray(requested) && requested.length > 0;
      testCmd = explicitTestCommand ? assertTestCommand(requested) : ["node", "-e", "process.exit(0)"];
      testsBasis = explicitTestCommand ? "contract_command" : "internal_default_noop";
    } catch (err) {
      if (err instanceof GitPolicyError) throw new Error(`coding_input_rejected:${err.reason}`);
      throw err;
    }

    // Policy-mandat for utgående push (klasse C) - delegert agent omgår aldri policy.
    // WP-C3 (review F3): en funksjon, fordi samme avgjørelse kjøres PÅ NYTT rett før push - kill switch, frys eller endret policy kan ha slått inn i løpet av agentkjøringen og testene.
    const repoUrl: string = input.repo_url;
    const authorizePush = async (): Promise<void> => {
      const decision = await deps.policy.authorize({
        identity: deps.identityFor(task),
        toolCall: {
          tool_id: "git",
          action: "push_branch",
          capability_class: "C",
          parameters: { repo: repoUrl, branch }
        }
      });
      if (decision.decision !== "ALLOW") {
        throw new Error(`policy_denied:${decision.reason}`);
      }
    };
    await authorizePush();

    const jobEnv: Record<string, string> = {};
    if (deps.claudeCodeCredential) {
      const ref = deps.claudeCodeCredential.ref ?? "ANTHROPIC_API_KEY";
      const value = await deps.claudeCodeCredential.secretProvider.get(ref);
      if (value) jobEnv[ref] = value;
    }

    // D-103 (Blokker B): løses FØR sandboxen opprettes - en jobb som ikke kan
    // autentisere git-transport skal ALDRI komme så langt som å klone noe.
    let gitAuth: Awaited<ReturnType<typeof createGitAuthHandle>> | undefined;
    /**
     * WP-C1 review B-M2: per-credential-tilbakekalling (`owner_controls.revoke_credential` på git-refen, WP-C3 F3) som EN delt sjekk. I host-modus utsteder worker ikke noe token (runnerens egen
     * credential brukes), så `issueGitToken` kjøres aldri der - uten denne sjekken hadde eierens tilbakekalling ingen virkning på kodejobber i host-modus (både PAT-fil og `source: request`).
     * Kalles derfor FØR klone og FØR publish i host-modus, og FØR hver utstedelse ellers. Fail-closed: feiler selve sjekken regnes credentialen som «ikke bevist ikke-tilbakekalt».
     * Uten `gitAuth.isRevoked` finnes det ingenting å sjekke mot (lokale repoer, tester).
     */
    const assertNotRevoked = async (): Promise<void> => {
      const auth = deps.gitAuth;
      if (!auth?.isRevoked) return;
      let revoked: boolean;
      try {
        revoked = await auth.isRevoked(auth.ref ?? "JARVIS_GITHUB_TOKEN");
      } catch {
        throw new Error("git_auth_revocation_check_failed"); // fail-closed: kan ikke bevise at credentialen ikke er tilbakekalt
      }
      if (revoked) throw new Error("git_auth_revoked");
    };
    /**
     * WP-C3 (review F2/F3/F13): ÉN utstedelse av git-credential. Kalles FØR sandboxen opprettes (tilgjengelighet bevises før noe klones) OG rett før hver git-nettverksoperasjon, så et kortlevd,
     * repo-scopet token aldri er eldre enn selve operasjonen. Hver utstedelse sjekker først per-credential-tilbakekalling (ingen utstedelse for en tilbakekalt credential).
     */
    const issueGitToken = async (): Promise<string> => {
      const auth = deps.gitAuth as NonNullable<typeof deps.gitAuth>;
      const ref = auth.ref ?? "JARVIS_GITHUB_TOKEN";
      await assertNotRevoked();
      let token: string | null = null;
      let code = "";
      try {
        token = auth.credentialSource ? await auth.credentialSource.tokenFor(credentialSlug as string) : await auth.secretProvider.get(ref);
      } catch (err) {
        // Kun en lukket feilkode (aldri meldingen): kilden kan i prinsippet bære detaljer fra leverandøren.
        const raw = (err as { code?: unknown } | null)?.code;
        code = typeof raw === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(raw) ? raw : "";
      }
      if (!token) {
        throw new Error(code ? `git_auth_unavailable:${code}` : "git_auth_unavailable");
      }
      return token;
    };
    // WP-C1: i host-git-modus (jobb-runneren) bruker RUNNEREN sin egen per-repo-credential på verten - worker utsteder/ser aldri et git-token.
    if (deps.gitAuth && !hostGit) {
      gitAuth = await createGitAuthHandle(await issueGitToken(), githubCredentialScope(credentialSlug as string));
    }
    /** Env med et NYTT token for ÉN git-nettverksoperasjon (clone eller push) - `undefined` uten gitAuth (lokale repoer, uendret). */
    const networkEnv = async (): Promise<Readonly<Record<string, string>> | undefined> => (gitAuth ? gitAuth.envFor(await issueGitToken()) : undefined);

    try {
      const sandbox = await deps.sandbox.create(jobEnv, { task_id: task.task_id, tenant_id: task.tenant_id });
      try {
      // `run` brukes for agent.modify() OG alle LOKALE git-operasjoner (branch/
      // add/commit/status/show/rev-parse) - ALDRI gitAuth.env. Kun de to
      // faktiske nettverkskallene (clone/push, under) kaller sandbox.exec()
      // direkte med gitAuth?.env som fjerde argument - dette er den ENESTE
      // veien token-verdien noensinne når et git-underprosess-env, og den når
      // ALDRI `run` (og dermed ALDRI `ClaudeCodeAgent`s eget exec-kall).
      const run: CodingAgentExec = (cmd, args, timeoutMs) =>
        sandbox.exec(cmd, cmd === "git" ? [...GIT_LOCAL_HARDENING_ARGS, ...args] : args, timeoutMs);
      const localGit = (args: string[]) => sandbox.exec("git", [...GIT_LOCAL_HARDENING_ARGS, ...args]);
      const must = (label: string, result: { code: number; stderr?: string }) => {
        if (result.code !== 0) {
          throw new Error(`${label}_failed: ${result.stderr ?? ""}`.slice(0, 300));
        }
      };
      // D-103 HOST-FIX v1+v2: `-c credential.helper=` (kun når gitAuth er
      // konfigurert) nullstiller PROSESS-LOKALT en eventuell ambient
      // credential.helper (f.eks. Windows Git Credential Manager) FØR git i
      // det hele tatt får sjansen til å svare med en cached, feil-innlogget
      // identitet, og den påfølgende `credentialHelperArgs`-tuppelen
      // registrerer Jarvis sin EGEN ephemere, shell-evaluerte credential-
      // helper i den (nå tomme) kjeden - se git-auth.ts sin doc-kommentar for
      // full begrunnelse (v2 erstattet den tidligere GIT_ASKPASS-mekanismen
      // etter en ekte Windows-spawn-feil). Uten gitAuth (default) er argv-et
      // 100% uendret fra før denne fiksen.
      // REMEDIERING DEL 2: nettverkskall får i tillegg GIT_HARDENING_ARGS (hooks av, kun https, ingen redirect-følging,
      // ingen submoduler) og credential-scopet (host + repo) - se git-policy.ts / git-auth.ts.
      const netArgs = (args: string[]): string[] =>
        (gitAuth ? [...GIT_CREDENTIAL_ISOLATION_ARGS, ...gitAuth.credentialHelperArgs, ...GIT_HARDENING_ARGS, ...args] : ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", ...args]);
      if (hostGit) {
        // Klone på VERTEN, med runnerens credential, til en katalog runneren selv oppretter (monteres som /work). Ingenting av dette berører worker.
        if (!sandbox.gitCheckout || !sandbox.gitPublish) throw new Error("host_git_not_supported_by_sandbox");
        await assertNotRevoked(); // B-M2: eierens tilbakekalling stopper også en host-jobb - FØR runneren får beskjed om å klone (og før noe token hentes for `source: request`)
        await sandbox.gitCheckout({ repoUrl: cloneUrl, ...(deps.github?.base ? { baseBranch: deps.github.base } : {}) });
      } else {
        must("clone", await sandbox.exec("git", netArgs(["clone", "--", cloneUrl, "."]), undefined, await networkEnv()));
      }
      await ctx.assertNotCancelled();
      must("branch", await run("git", ["checkout", "-b", branch]));
      const description = await deps.agent.modify(run, task.contract.goal);
      await ctx.saveCheckpoint({ step: "modified", branch });
      await ctx.assertNotCancelled();

      const testResult = await sandbox.exec(testCmd[0] as string, testCmd.slice(1));
      await deps.artifacts.save(task.tenant_id, task.task_id, "test-log", "tests.txt",
        `exit=${testResult.code}\n${testResult.stdout}\n${testResult.stderr}`);
      must("tests", testResult);

      // D-101: sjekk FØR noen `git add`/`commit` forsøkes - en agent som
      // korrekt og ærlig ikke gjorde noen endring (f.eks. fordi den ikke
      // hadde grunnlag for å gjette en verdi) skal ALDRI tvinges gjennom en
      // tom commit eller få dette fremstilt som en git-/harness-mekanikk-feil.
      const status = await localGit(["status", "--porcelain"]);
      if (status.stdout.trim().length === 0) {
        throw new Error(NO_CHANGES_TO_COMMIT_LABEL);
      }
      must("add", await run("git", ["add", "-A"]));
      must("commit", await run("git", ["commit", "-m", `jarvis: ${task.contract.goal}`]));
      let commitSha = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
      const diff = await localGit(["show", "--stat", "HEAD"]);
      await deps.artifacts.save(task.tenant_id, task.task_id, "patch", "change.txt", diff.stdout);
      // D-103 §13: kansellering FØR push - den nyeste, første EKSTERNE
      // sideeffekten (en ekte branch synlig på GitHub) skal ALDRI skje etter
      // en allerede innkommet kanselleringsforespørsel.
      await ctx.assertNotCancelled();
      // WP-C3 (review F3): policy (kill switch, frys) vurderes på nytt rett før den eksterne bivirkningen - den første vurderingen er mange minutter gammel.
      await authorizePush();
      // Guard i runneren: kun jobb-branchen pushes; aldri beskyttede brancher.
      if (hostGit) {
        // Publish via verifisert git-bundle: runneren lager bundlen i containeren (uten credential), verifiserer den i et ferskt bare-repo
        // på verten og pusher KUN den verifiserte committen til denne jobb-branchen. SHA-en runneren faktisk pushet er autoritativ.
        await assertNotRevoked(); // B-M2: en credential som er tilbakekalt MIDT i jobben stopper publiseringen (samme sjekk som før klonen)
        // B-L6: runneren avviser FØR pushen hvis den verifiserte committen ikke er den vi leste i containeren (`expectedSha`). Sjekken under er beholdt som siste skanse (eldre runner uten feltet).
        const published = await (sandbox.gitPublish as NonNullable<typeof sandbox.gitPublish>)({ branch, expectedSha: commitSha });
        if (published.commitSha !== commitSha) throw new Error("published_commit_mismatch");
        commitSha = published.commitSha;
      } else {
        must("push", await sandbox.exec("git", netArgs(["push", "origin", `${branch}:${branch}`]), undefined, await networkEnv()));
      }
      await deps.artifacts.save(task.tenant_id, task.task_id, "pr-proposal", "pr.json",
        JSON.stringify({ branch, title: `jarvis: ${task.contract.goal}`, body: description, merge: "KREVER MENNESKELIG GODKJENNING" }));

      let pr: Awaited<ReturnType<typeof publishPullRequestForCodingJob>> | undefined;
      if (deps.github) {
        // D-103 §13: kansellering FØR PR-publisering - branchen er allerede
        // pushet (ufarlig, gjenbrukes idempotent av D-95 ved en senere retry),
        // men en NY PR skal ALDRI opprettes etter kansellering.
        await ctx.assertNotCancelled();
        pr = await publishPullRequestForCodingJob({
          gateway: deps.github.gateway,
          identity: deps.identityFor(task),
          jobContract: task.contract,
          repoUrl: input.repo_url,
          branch,
          base: deps.github.base ?? "main",
          title: `jarvis: ${task.contract.goal}`,
          body: description
        });
        await deps.artifacts.save(task.tenant_id, task.task_id, "pr-result", "pr-result.json", JSON.stringify(pr));
      }

      return { branch, description, tests: "passed", tests_basis: testsBasis, commit_sha: commitSha, ...(pr ? { pr } : {}) };
      } finally {
        await sandbox.dispose();
      }
    } finally {
      // D-103 (Blokker B): ephemert credential-helper-materiale fjernes
      // UAVHENGIG av om sandboxen selv noensinne ble opprettet (dekker det
      // sjeldne tilfellet der `deps.sandbox.create()` feiler ETTER at
      // gitAuth allerede ble generert) - egen temp-katalog, aldri inne i
      // sandbox.workdir.
      if (gitAuth) await gitAuth.cleanup();
    }
  };
}

/**
 * D-102: defense-in-depth for production coding jobs (§7/§23 i byggeordren) -
 * ALDRI en ny hemmelighet-lagringsmekanisme, KUN en siste sikkerhetsnett rundt
 * ETHVERT thrown-error-budskap som når `queue.fail()` (og dermed
 * `tasks.last_error`, lesbar via `TaskService.get()`). `createCodingHandler`
 * injiserer selv ALDRI en hemmelighet i en feilmelding den bygger - men den
 * ekte Claude Code-CLI-en (subprosess, utenfor Jarvis sin kontroll) kunne i
 * prinsippet ekko sin egen `ANTHROPIC_API_KEY`-miljøvariabel tilbake i
 * stdout/stderr, som `ClaudeCodeAgent.modify()` da ville inkludert (trunkert
 * til 300 tegn) i en kastet `claude_code_cli_failed:`-feil. Wrapperen fjerner
 * ethvert kjent hemmelig-formet argument fra `err.message` FØR det noensinne
 * når køen - identisk teknikk som den allerede eksisterende, testede
 * `redactSecrets()` i `coding-agent-eval.ts` (D-98), ALDRI en ny mekanisme.
 */
export function withSecretRedaction(handler: TaskHandler, secrets: readonly RedactionSecret[] | RedactionSecretSource): TaskHandler {
  return async (task, ctx) => {
    try {
      return await handler(task, ctx);
    } catch (err) {
      let message = (err as Error).message;
      for (const secret of collectRedactionSecrets(secrets)) {
        message = message.split(secret).join("[REDACTED]");
      }
      throw new Error(message);
    }
  };
}

/** En DYNAMISK kilde til hemmeligheter, lest PÅ FEILTIDSPUNKTET (f.eks. kortlevde GitHub App-installasjonstokens, nye hver time og dermed ukjente ved oppstart). */
export type RedactionSecretSource = () => readonly (string | undefined)[];
/** Et element i hemmelighetslisten: en statisk verdi (`undefined`/tom hoppes over) eller en dynamisk kilde. */
export type RedactionSecret = string | undefined | RedactionSecretSource;

/**
 * Samler hemmelighetene som skal redigeres. WP-C3 (review F12): hver DYNAMISK kilde skjermes for seg - en kilde som kaster hopper kun over SEG SELV, aldri resten av listen (tidligere ble hele
 * listen, også de statiske nøklene, hoppet over når funksjonen kastet). En kastende kilde skjuler heller aldri den opprinnelige jobbfeilen. Hele listen kan fortsatt være én funksjon.
 */
function collectRedactionSecrets(secrets: readonly RedactionSecret[] | RedactionSecretSource): string[] {
  const out: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) out.push(value);
  };
  const readSource = (source: RedactionSecretSource): void => {
    try {
      for (const value of source()) add(value);
    } catch {
      // Kilden er nede: de øvrige kildene redigeres likevel.
    }
  };
  if (typeof secrets === "function") {
    readSource(secrets);
  } else {
    for (const secret of secrets) {
      if (typeof secret === "function") readSource(secret);
      else add(secret);
    }
  }
  return out;
}
