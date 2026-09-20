/**
 * Task #121 (D-214): en LITEN, EGEN GitHub-HTTP-klient - BEVISST IKKE via
 * `ToolGateway.execute({tool_id:"github", action:"merge_pr"})`. `github.
 * merge_pr` er klasse D ("ikke reverserbar - derfor klasse D", se
 * integrations.ts) og skal FORBLI en generell, eier-autorisert handling for
 * VILKÅRLIGE PR-er - å la denne sveipen kalle den (selv med eierens egen
 * identitet) ville enten krevd en ny, generell "sovereign eier kan
 * automatisere klasse D fra en bakgrunnsjobb"-unntaksregel i PolicyGateway
 * (en FARLIG, altfor bred utvidelse for én smal use case), ELLER stille lent
 * seg på den eksisterende "sovereign eier får instant D-utførelse"-regelen
 * utenfor dens tiltenkte kontekst (en LEVENDE samtaleturn, ikke en
 * ubevoktet bakgrunnssveip). `pr-publisher.ts` sin egen doc-kommentar er
 * eksplisitt: "ALDRI merge (klasse D, github.merge_pr forblir en separat,
 * eier-autorisert handling denne modulen aldri kaller)" - denne modulen
 * respekterer nøyaktig samme grense ved å ALDRI røre `github.merge_pr` i
 * det hele tatt, og i stedet eie en HELT EGEN, strukturelt smalere
 * kapabilitet (`self_modification.merge_personality_change`, klasse B) med
 * sin egen, separate HTTP-vei - se service.ts for de strukturelle
 * garantiene (kun ÉN kjent branch, kun ÉN kjent fil, CI-grønt, diff
 * reverifisert FØR merge) som gjør DENNE smale veien trygg uten å bruke -
 * eller utvide omfanget av - den generelle D-klasse-handlingen.
 */
export type CiStatus = "pending" | "success" | "failure";

export interface SelfModificationGithubClient {
  /** Kombinert CI-status for HEAD-SHA-en til en branch (`GET .../commits/{ref}/status`). */
  getCombinedCiStatus(repo: string, ref: string): Promise<CiStatus>;
  /** Filstiene en PR faktisk endrer - reverifisert RETT FØR merge, aldri kun stolt på fra opprettelsestidspunktet. */
  getPullRequestChangedFiles(repo: string, prNumber: string): Promise<string[]>;
  /** HEAD-SHA-en til en PR - brukt som `sha`-precondition ved merge (unngår en TOCTOU-race mot en ny commit på branchen). */
  getPullRequestHeadSha(repo: string, prNumber: string): Promise<string>;
  mergePullRequest(repo: string, prNumber: string, opts: { sha: string; commitTitle: string }): Promise<{ merged: boolean; message?: string }>;
}

const GITHUB_API_VERSION = "2022-11-28";

function githubHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "jarvis-self-modification",
    "x-github-api-version": GITHUB_API_VERSION,
    ...extra
  };
}

export class HttpSelfModificationGithubClient implements SelfModificationGithubClient {
  constructor(private readonly token: string) {}

  async getCombinedCiStatus(repo: string, ref: string): Promise<CiStatus> {
    const response = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}/status`, {
      headers: githubHeaders(this.token)
    });
    if (!response.ok) throw new Error(`self_modification_github_status_${response.status}`);
    const body = (await response.json()) as { state?: string };
    if (body.state === "success") return "success";
    if (body.state === "failure" || body.state === "error") return "failure";
    return "pending";
  }

  async getPullRequestChangedFiles(repo: string, prNumber: string): Promise<string[]> {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100`, {
      headers: githubHeaders(this.token)
    });
    if (!response.ok) throw new Error(`self_modification_github_files_${response.status}`);
    const body = (await response.json()) as Array<{ filename: string }>;
    return body.map((f) => f.filename);
  }

  async getPullRequestHeadSha(repo: string, prNumber: string): Promise<string> {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      headers: githubHeaders(this.token)
    });
    if (!response.ok) throw new Error(`self_modification_github_pr_${response.status}`);
    const body = (await response.json()) as { head?: { sha?: string } };
    if (!body.head?.sha) throw new Error("self_modification_github_pr_missing_head_sha");
    return body.head.sha;
  }

  async mergePullRequest(repo: string, prNumber: string, opts: { sha: string; commitTitle: string }): Promise<{ merged: boolean; message?: string }> {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, {
      method: "PUT",
      headers: githubHeaders(this.token, { "content-type": "application/json" }),
      body: JSON.stringify({ sha: opts.sha, commit_title: opts.commitTitle, merge_method: "merge" })
    });
    const body = (await response.json().catch(() => ({}))) as { merged?: boolean; message?: string };
    if (!response.ok) {
      // 405 = "ikke mergbar akkurat nå" (f.eks. en ny commit siden `sha`-precondition,
      // eller en branch-beskyttelsesregel) - en NORMAL, forventet avvisning, ikke en
      // uventet feil. Kalleren (service.ts) lar raden forbli `pending_ci` og prøver på
      // nytt neste sveip - ALDRI en stille "vellykket" rapportering.
      return { merged: false, message: body.message ?? `http_${response.status}` };
    }
    return { merged: body.merged === true, ...(body.message !== undefined ? { message: body.message } : {}) };
  }
}

/**
 * D-102-mønster (samme begrunnelse som `resolveGitToken` i service.ts):
 * tokenet oppløses PÅ NYTT for HVERT kall - `sweepPendingRequests()` kjører
 * periodisk over prosessens levetid, og en statisk `HttpSelfModificationGithubClient`
 * konstruert ÉN gang ved oppstart ville ALDRI sett en senere token-rotasjon
 * (f.eks. Infisical-basert, D-211) før neste restart. En manglende verdi
 * kaster EKSPLISITT (`self_modification_git_auth_unavailable`) - samme
 * fail-closed-kontrakt som git-push-veien, ALDRI et stille uautentisert kall.
 */
export class ResolvingSelfModificationGithubClient implements SelfModificationGithubClient {
  constructor(private readonly resolveToken: () => Promise<string | null>) {}

  private async client(): Promise<HttpSelfModificationGithubClient> {
    const token = await this.resolveToken();
    if (!token) throw new Error("self_modification_git_auth_unavailable");
    return new HttpSelfModificationGithubClient(token);
  }

  async getCombinedCiStatus(repo: string, ref: string): Promise<CiStatus> {
    return (await this.client()).getCombinedCiStatus(repo, ref);
  }

  async getPullRequestChangedFiles(repo: string, prNumber: string): Promise<string[]> {
    return (await this.client()).getPullRequestChangedFiles(repo, prNumber);
  }

  async getPullRequestHeadSha(repo: string, prNumber: string): Promise<string> {
    return (await this.client()).getPullRequestHeadSha(repo, prNumber);
  }

  async mergePullRequest(
    repo: string,
    prNumber: string,
    opts: { sha: string; commitTitle: string }
  ): Promise<{ merged: boolean; message?: string }> {
    return (await this.client()).mergePullRequest(repo, prNumber, opts);
  }
}
