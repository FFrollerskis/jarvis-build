import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import type { SandboxRunner } from "@jarvis/tasks";
import { GIT_CREDENTIAL_ISOLATION_ARGS, createGitAuthHandle, publishPullRequestForCodingJob, type PrPublishingGateway } from "@jarvis/tasks";
import { classifySelfModification } from "./policy.ts";
import { PersonalityConfigSchema, type PersonalityConfig, type SelfModificationRequest, type SelfModificationRequestStatus } from "./types.ts";
import type { SelfModificationGithubClient } from "./github-client.ts";

const PERSONALITY_CONFIG_PATH = "config/charlie-personality.json";

export interface SelfModificationServiceDeps {
  pool: pg.Pool;
  sandbox: SandboxRunner;
  /**
   * D-102-mønster (createCodingHandler sitt `gitAuth`-felt): oppløses PÅ
   * HVERT kall, ALDRI cachet - reflekterer token-rotasjon, og en manglende
   * verdi feiler eksplisitt (`self_modification_git_auth_unavailable`) FØR
   * noe git-arbeid forsøkes, ALDRI et stille fall til uautentisert git.
   */
  resolveGitToken: () => Promise<string | null>;
  githubClient: SelfModificationGithubClient;
  /** Gjenbruker DEN SAMME `github.create_pr`-veien (klasse C) som UA-5 sin kodejobb-pipeline - INGEN ny PR-opprettelsesmekanisme. */
  prGateway: PrPublishingGateway;
  /** `owner/repo` - default matcher SAMME repo `connector-registry.ts` sin github-`live_test` allerede antar. */
  repoSlug?: string;
  baseBranch?: string;
  /** `JARVIS_OWNER_PERSON_ID` - selvendring er en eier-KUN-handling, se `assertOwner()`. */
  ownerPersonId: string;
}

function requestRowFromDb(row: Record<string, unknown>): SelfModificationRequest {
  return {
    request_id: row["request_id"] as string,
    kind: row["kind"] as string,
    risk: row["risk"] as SelfModificationRequest["risk"],
    target_paths: row["target_paths"] as string[],
    branch: row["branch"] as string,
    pr_number: row["pr_number"] as string,
    pr_url: row["pr_url"] as string,
    status: row["status"] as SelfModificationRequestStatus,
    requested_by_person_id: row["requested_by_person_id"] as string,
    summary: row["summary"] as string,
    created_at: (row["created_at"] as Date).toISOString(),
    resolved_at: row["resolved_at"] ? (row["resolved_at"] as Date).toISOString() : null,
    resolved_by_person_id: (row["resolved_by_person_id"] as string | null) ?? null
  };
}

/**
 * Task #121 (D-214): se README-kommentaren i policy.ts/github-client.ts for
 * den fulle sikkerhetsbegrunnelsen. Denne tjenesten eier BEGGE de to
 * lagene D-208 vedtok: (1) `proposePersonalityChange()` - den ENESTE
 * produsenten av `zero_review`-klassifiserte forespørsler i denne sliceen,
 * strukturelt begrenset til ÉN skjemavalidert fil - og (2) `sweepPending
 * Requests()` - CI-portvakten som faktisk utfører zero-review-automergen,
 * OG (3) `resolveApproval()` - den generiske Telegram-godkjennings-
 * tilstandsmaskinen for `requires_approval`-sporet (produsenten av EKTE
 * `requires_approval`-forespørsler for vilkårlige kodeendringer er BEVISST
 * IKKE bygget i denne sliceen - se task #123/D-214 sitt "bevisst utsatt"-
 * avsnitt i DECISIONS_AND_ASSUMPTIONS.md).
 */
export class SelfModificationService {
  private readonly repoSlug: string;
  private readonly baseBranch: string;

  constructor(private readonly deps: SelfModificationServiceDeps) {
    this.repoSlug = deps.repoSlug ?? process.env["JARVIS_GITHUB_REPO"] ?? "tsworkflow/jarvisbuild";
    this.baseBranch = deps.baseBranch ?? "main";
  }

  /**
   * D-68-disiplin: kalleren gir DEN EKTE, løste identiteten - denne
   * metoden fabrikkerer eller eskalerer ALDRI en identitet selv. Kun
   * `assertOwner()` under avgjør autoritet, basert på DEN identiteten.
   */
  private assertOwner(identity: IdentityContext): void {
    if (identity.person_id !== this.deps.ownerPersonId) {
      throw new Error("self_modification_owner_only");
    }
  }

  /**
   * Zero-review-sporet. Skjemavalidering (PersonalityConfigSchema) skjer
   * FØR noe git-arbeid i det hele tatt - en ugyldig konfig kaster her,
   * INGEN branch/commit/PR for den. `classifySelfModification()` kjøres
   * likevel eksplisitt mot den FAKTISKE, ENESTE endrede stien (aldri
   * hardkodet forbi klassifiseringsmotoren) - det er den SAMME autoriteten
   * `sweepPendingRequests()` re-verifiserer senere, ikke en snarvei.
   */
  async proposePersonalityChange(
    identity: IdentityContext,
    input: { tone_descriptors: string[]; style_notes: string }
  ): Promise<{ request_id: string; pr_number: string; pr_url: string; branch: string; risk: string }> {
    this.assertOwner(identity);

    const config: PersonalityConfig = PersonalityConfigSchema.parse({
      tone_descriptors: input.tone_descriptors,
      style_notes: input.style_notes,
      updated_at: new Date().toISOString(),
      updated_by: identity.person_id
    });

    const risk = classifySelfModification([PERSONALITY_CONFIG_PATH]);
    if (risk !== "zero_review") {
      // Strukturelt uråkbart med DAGENS allowlist (policy.ts har KUN denne
      // ene stien) - men fail-closed likevel: en fremtidig regresjon i
      // policy.ts skal ALDRI stille la personlighetsendringer automerges.
      throw new Error(`self_modification_unexpected_risk:${risk}`);
    }

    const gitToken = await this.deps.resolveGitToken();
    if (!gitToken) throw new Error("self_modification_git_auth_unavailable");

    const branch = `jarvis/self-mod/personality-${Date.now()}`;
    const gitAuth = await createGitAuthHandle(gitToken);
    const sandbox = await this.deps.sandbox.create();
    try {
      const netArgs = (args: string[]): string[] => [...GIT_CREDENTIAL_ISOLATION_ARGS, ...gitAuth.credentialHelperArgs, ...args];
      const repoUrl = `https://github.com/${this.repoSlug}.git`;
      const mustOk = (label: string, result: { code: number; stderr?: string }) => {
        if (result.code !== 0) throw new Error(`self_modification_${label}_failed:${(result.stderr ?? "").slice(0, 200)}`);
      };
      mustOk("clone", sandbox.exec("git", netArgs(["clone", "--depth", "1", "--branch", this.baseBranch, repoUrl, "."]), undefined, gitAuth.env));
      mustOk("branch", sandbox.exec("git", ["checkout", "-b", branch]));
      const content = `${JSON.stringify(config, null, 2)}\n`;
      const writeResult = sandbox.exec("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(PERSONALITY_CONFIG_PATH)}, ${JSON.stringify(content)})`]);
      mustOk("write_config", writeResult);
      mustOk("add", sandbox.exec("git", ["add", "--", PERSONALITY_CONFIG_PATH]));
      // D-101-mønster (coding.ts): sjekk at NØYAKTIG den forventede stien ble
      // endret FØR commit - en agent/prosess-feil som ved et uhell rørte en
      // annen fil skal ALDRI committes stille.
      const staged = sandbox.exec("git", ["diff", "--cached", "--name-only"]);
      const stagedPaths = staged.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (stagedPaths.length !== 1 || stagedPaths[0] !== PERSONALITY_CONFIG_PATH) {
        throw new Error(`self_modification_unexpected_staged_paths:${stagedPaths.join(",")}`);
      }
      mustOk("commit", sandbox.exec("git", ["commit", "-m", `jarvis: oppdater Charlie sin personlighetskonfig (${identity.person_id})`]));
      mustOk("push", sandbox.exec("git", netArgs(["push", "origin", `${branch}:${branch}`]), undefined, gitAuth.env));

      const taskId = `self-mod-${randomUUID()}`;
      const jobContract: JobContract = {
        task_id: taskId,
        owner_person_id: identity.person_id,
        tenant_id: identity.tenant_id,
        goal: "self-modification: personality config update",
        acceptance_criteria: ["config/charlie-personality.json validates against PersonalityConfigSchema"],
        input: { data: {}, trust_level: "internal", provenance: "self-modification-service" },
        allowed_tools: ["github"],
        allowed_memory_spaces: [],
        allowed_network_targets: [],
        agent_profile: "executive",
        model_budget_ore: 0,
        retry_policy: { max_attempts: 1, backoff_seconds: 0 },
        max_steps: 1
      };
      const pr = await publishPullRequestForCodingJob({
        gateway: this.deps.prGateway,
        identity,
        jobContract,
        repoUrl,
        branch,
        base: this.baseBranch,
        title: "jarvis: oppdater Charlie sin personlighetskonfig",
        body:
          `Zero-review selvendring (task #121, D-214) - eneste endrede fil: \`${PERSONALITY_CONFIG_PATH}\`.\n\n` +
          `Automerges av \`SelfModificationService.sweepPendingRequests()\` når CI er grønt OG diffen fortsatt ` +
          `er eksakt denne ene filen - ingen manuell gjennomgang for DENNE navngitte, skjemavaliderte konfigurasjonen.`
      });
      if (pr.status === "failed" || pr.status === "skipped_not_allowed" || pr.status === "skipped_unparseable_repo") {
        throw new Error(`self_modification_pr_publish_failed:${pr.status}:${pr.reason ?? ""}`);
      }
      if (!pr.pr_number) {
        throw new Error("self_modification_pr_missing_number");
      }

      const requestId = `selfmod-${randomUUID()}`;
      await this.deps.pool.query(
        `INSERT INTO self_modification_requests
           (request_id, kind, risk, target_paths, branch, pr_number, pr_url, status, requested_by_person_id, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          requestId, "personality_config", risk, [PERSONALITY_CONFIG_PATH], branch, pr.pr_number, pr.pr_url ?? "",
          "pending_ci", identity.person_id, `Personlighetskonfig oppdatert av ${identity.person_id}`
        ]
      );
      return { request_id: requestId, pr_number: pr.pr_number, pr_url: pr.pr_url ?? "", branch, risk };
    } finally {
      await sandbox.dispose();
      await gitAuth.cleanup();
    }
  }

  /**
   * CI-portvakten. Kjøres periodisk (se apps/api/src/main.ts) ELLER on-demand.
   * For HVER åpen `pending_ci`-rad: CI-status FØRST (billig, ingen mutasjon
   * mulig fra en rød/ventende sjekk), DERETTER en FERSK reverifisering av
   * PR-ens FAKTISKE endrede filer direkte fra GitHub (ALDRI kun stolt på
   * `target_paths` fra opprettelsestidspunktet - en branch kunne i
   * prinsippet fått flere pushes siden), FØRST DERETTER selve merget.
   * Et avvik i NOEN av disse stegene lar raden forbli `pending_ci` (prøves
   * på nytt neste sveip) eller markeres `ci_failed` - ALDRI en stille merge.
   */
  async sweepPendingRequests(): Promise<{ merged: string[]; still_pending: string[]; failed: string[] }> {
    const rows = await this.deps.pool.query(
      "SELECT * FROM self_modification_requests WHERE status = 'pending_ci' AND risk = 'zero_review' ORDER BY created_at"
    );
    const merged: string[] = [];
    const stillPending: string[] = [];
    const failed: string[] = [];
    for (const row of rows.rows as Array<Record<string, unknown>>) {
      const request = requestRowFromDb(row);
      try {
        const outcome = await this.attemptMerge(request);
        if (outcome === "merged") merged.push(request.request_id);
        else if (outcome === "failed") failed.push(request.request_id);
        else stillPending.push(request.request_id);
      } catch {
        // Én rads feil stjeler ALDRI resten av sveipen (samme isolasjons-
        // disiplin som TelegramCommandPoller sin per-melding-try/catch).
        stillPending.push(request.request_id);
      }
    }
    return { merged, still_pending: stillPending, failed };
  }

  private async attemptMerge(request: SelfModificationRequest): Promise<"merged" | "pending" | "failed"> {
    const ci = await this.deps.githubClient.getCombinedCiStatus(this.repoSlug, request.branch);
    if (ci === "pending") return "pending";
    if (ci === "failure") {
      await this.markResolved(request.request_id, "ci_failed", null);
      return "failed";
    }

    // Reverifisering: EKSAKT `target_paths` (aldri mer, aldri mindre) - se
    // klassekommentaren. En diff som har vokst siden opprettelsen (uansett
    // årsak) blokkerer automerge her, permanent for DENNE forespørselen -
    // ALDRI et stille "merge likevel fordi CI tilfeldigvis er grønt".
    const actualFiles = await this.deps.githubClient.getPullRequestChangedFiles(this.repoSlug, request.pr_number);
    const expected = [...request.target_paths].sort();
    const actual = [...actualFiles].sort();
    const diffMatches = expected.length === actual.length && expected.every((p, i) => p === actual[i]);
    if (!diffMatches || classifySelfModification(actualFiles) !== "zero_review") {
      await this.markResolved(request.request_id, "ci_failed", null);
      return "failed";
    }

    const headSha = await this.deps.githubClient.getPullRequestHeadSha(this.repoSlug, request.pr_number);
    const result = await this.deps.githubClient.mergePullRequest(this.repoSlug, request.pr_number, {
      sha: headSha,
      commitTitle: `jarvis: ${request.summary}`
    });
    if (!result.merged) return "pending"; // f.eks. 405/stale sha - prøves på nytt neste sveip
    await this.markResolved(request.request_id, "merged", null);
    return "merged";
  }

  private async markResolved(requestId: string, status: SelfModificationRequestStatus, resolvedBy: string | null): Promise<void> {
    await this.deps.pool.query(
      "UPDATE self_modification_requests SET status = $2, resolved_at = now(), resolved_by_person_id = $3 WHERE request_id = $1",
      [requestId, status, resolvedBy]
    );
  }

  /**
   * Task #121 (D-214), requires_approval-sporet: den GENERISKE Telegram-
   * godkjennings-tilstandsmaskinen - uavhengig av HVA slags endring
   * forespørselen representerer (`kind`). Kalt fra
   * `TelegramCommandPoller`'s nye `/approve`/`/avvis`-håndtering
   * (apps/api/src/main.ts), ALLEREDE autentisert via den eksisterende,
   * betrodde eier-chat-bindingen FØR denne metoden i det hele tatt nås -
   * `actorPersonId` her er derfor den KONFIGURERTE eier-identiteten
   * (JARVIS_OWNER_PERSON_ID), ALDRI noe fra selve Telegram-meldingsteksten.
   *
   * BEVISST IKKE her: selve ANVENDELSEN av en godkjent vilkårlig kodeendring
   * (den delen krever en PRODUSENT av EKTE `requires_approval`-forespørsler
   * for kodeendringer utover personlighetskonfigen - se task #123). Denne
   * metoden garanterer KUN at tilstandsoverganger pending->approved/rejected
   * er ekte, auditerte og eier-bundet - en fremtidig produsent kan stole på
   * den uendret.
   */
  async resolveApproval(requestId: string, decision: "approved" | "rejected", actorPersonId: string): Promise<SelfModificationRequest> {
    const existing = await this.deps.pool.query("SELECT * FROM self_modification_requests WHERE request_id = $1", [requestId]);
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("self_modification_request_not_found");
    const request = requestRowFromDb(row);
    if (request.status !== "awaiting_approval") {
      throw new Error(`self_modification_request_not_awaiting_approval:${request.status}`);
    }
    await this.markResolved(requestId, decision, actorPersonId);
    const updated = await this.deps.pool.query("SELECT * FROM self_modification_requests WHERE request_id = $1", [requestId]);
    return requestRowFromDb(updated.rows[0] as Record<string, unknown>);
  }

  async getRequest(requestId: string): Promise<SelfModificationRequest | null> {
    const result = await this.deps.pool.query("SELECT * FROM self_modification_requests WHERE request_id = $1", [requestId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? requestRowFromDb(row) : null;
  }
}
