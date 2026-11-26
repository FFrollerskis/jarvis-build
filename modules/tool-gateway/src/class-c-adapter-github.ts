/**
 * WP-AUTH2a (K3): klasse C-adapter for GitHub. Bruker KUN lese-handlinger som `GithubTransport` allerede har (`get_branch`, `list_pull_requests`, `get_pull_request`) og felt de allerede returnerer
 * (`toPullRequestSummary`: number, state, head_ref, base_ref, title, draft, merged, html_url). Ingen nye leverandør-API-antakelser.
 *
 * `github.create_pr` (klasse C, idempotent: GitHub svarer 422 «already exists» og transporten finner den eksisterende åpne PR-en for samme head/base):
 *   - mål-/kapabilitetsbevis: gyldig `eier/repo`, head og base uten blanke/kontrolltegn, head ≠ base, ikke-tom tittel;
 *   - preflight: head- og base-branchen finnes (en manglende gir `target_not_found` fra lesingen), begge kan leses; en åpen PR for samme head/base og lik sha er kun opplysninger (advarsler), aldri blokk;
 *   - etterkontroll: `get_pull_request` på det returnerte PR-nummeret - nummer, åpen, head, base, ikke merget og (kun når PR-en faktisk ble opprettet) tittel;
 *   - rollback: lukk PR-en med `github.update_pr` (kun når den ble opprettet nå; et idempotent treff endret ingenting).
 * `body` leses ikke tilbake av noen eksisterende lese-handling og står derfor i `unobservable`.
 */
import type { JsonValue } from "@jarvis/contracts";
import type { ClassCAdapter, ClassCReads, ClassCSnapshot } from "./class-c-pipeline.ts";
import { assertGithubRepoSlug } from "./url-safety.ts";

type Obj = Record<string, JsonValue>;

function asObject(value: JsonValue | null | undefined): Obj | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
}

function dataOf(reads: ClassCReads, id: string): JsonValue | null {
  const result = reads[id];
  return result !== undefined && result.ok ? result.data : null;
}

/** En «enkel» ref/identifikator: ikke-tom, begrenset lengde, uten blanke og kontrolltegn (git-referanser kan ikke ha dem). */
function isPlainToken(value: unknown, max = 255): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 32 || code === 127) return false;
  }
  return true;
}

const normaliseTitle = (title: string): string => title.replace(/\s+/g, " ").trim();
const baseOf = (p: Record<string, JsonValue>): string => (typeof p["base"] === "string" && p["base"] !== "" ? p["base"] : "main");

/** Det som sammenlignes av en PR (kun felt `toPullRequestSummary` returnerer). */
function prState(pr: Obj): Obj {
  return {
    number: typeof pr["number"] === "number" ? pr["number"] : null,
    state: typeof pr["state"] === "string" ? pr["state"] : null,
    head_ref: typeof pr["head_ref"] === "string" ? pr["head_ref"] : null,
    base_ref: typeof pr["base_ref"] === "string" ? pr["base_ref"] : null,
    title: typeof pr["title"] === "string" ? normaliseTitle(pr["title"]) : null,
    draft: pr["draft"] === true,
    merged: pr["merged"] === true
  };
}

function openPrFor(reads: ClassCReads, branch: string, base: string): Obj | null {
  const list = asObject(dataOf(reads, "open_prs"))?.["pull_requests"];
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const pr = asObject(entry);
    if (pr !== null && pr["head_ref"] === branch && pr["base_ref"] === base && pr["state"] === "open") return pr;
  }
  return null;
}

export const githubCreatePrAdapter: ClassCAdapter = {
  key: "github.create_pr",
  unobservable: ["body"],

  validate(p) {
    try {
      assertGithubRepoSlug(p["repo"]);
    } catch {
      return "repo_invalid";
    }
    if (!isPlainToken(p["branch"])) return "branch_invalid";
    const base = baseOf(p);
    if (!isPlainToken(base)) return "base_invalid";
    if (p["branch"] === base) return "head_equals_base";
    if (typeof p["title"] !== "string" || p["title"].trim() === "") return "title_missing";
    return null;
  },

  before: {
    reads: (p) => [
      { id: "head", action: "get_branch", parameters: { repo: p["repo"] ?? null, branch: p["branch"] ?? null } },
      { id: "base", action: "get_branch", parameters: { repo: p["repo"] ?? null, branch: baseOf(p) } },
      { id: "open_prs", action: "list_pull_requests", parameters: { repo: p["repo"] ?? null, state: "open" }, optional: true }
    ],
    judge(p, reads) {
      const head = asObject(dataOf(reads, "head"));
      const base = asObject(dataOf(reads, "base"));
      if (head === null || typeof head["sha"] !== "string") return { block: "head_branch_unreadable" };
      if (base === null || typeof base["sha"] !== "string") return { block: "base_branch_unreadable" };
      const warnings: string[] = [];
      if (head["sha"] === base["sha"]) warnings.push("head_equals_base_sha");
      const existing = openPrFor(reads, String(p["branch"]), baseOf(p));
      if (existing !== null) warnings.push("open_pr_exists");
      return { block: null, warnings };
    },
    snapshot(p, reads): ClassCSnapshot {
      const existing = openPrFor(reads, String(p["branch"]), baseOf(p));
      const head = asObject(dataOf(reads, "head"));
      const base = asObject(dataOf(reads, "base"));
      return {
        state: { pr: existing === null ? null : prState(existing) },
        context: { head_sha: typeof head?.["sha"] === "string" ? head["sha"] : null, base_sha: typeof base?.["sha"] === "string" ? base["sha"] : null, existing_open_pr: typeof existing?.["number"] === "number" ? existing["number"] : null }
      };
    }
  },

  after: {
    reads(p, mutation) {
      if (mutation.external_id === null || !/^[0-9]{1,10}$/.test(mutation.external_id)) return null;
      return [{ id: "pr", action: "get_pull_request", parameters: { repo: p["repo"] ?? null, pr_number: mutation.external_id } }];
    },
    snapshot(_p, _mutation, reads): ClassCSnapshot {
      const pr = asObject(dataOf(reads, "pr"));
      if (pr === null) throw new Error("class_c_github_pr_unreadable");
      return { state: { pr: prState(pr) }, context: { html_url: typeof pr["html_url"] === "string" ? pr["html_url"] : null, head_sha: typeof pr["head_sha"] === "string" ? pr["head_sha"] : null } };
    }
  },

  expect(p, mutation) {
    const created = asObject(mutation.data)?.["created"] === true;
    return [
      { path: "pr", op: "present" },
      { path: "pr.number", op: "equals", value: Number(mutation.external_id) },
      { path: "pr.state", op: "equals", value: "open" },
      { path: "pr.head_ref", op: "equals", value: String(p["branch"]) },
      { path: "pr.base_ref", op: "equals", value: baseOf(p) },
      { path: "pr.merged", op: "equals", value: false },
      // Tittelen sammenlignes kun for en PR vi faktisk opprettet (et idempotent treff er en eksisterende PR med sin egen tittel).
      ...(created ? [{ path: "pr.title", op: "equals" as const, value: normaliseTitle(String(p["title"])) }] : [])
    ];
  },

  rollback(p, mutation) {
    const created = asObject(mutation.data)?.["created"];
    if (created === false) return { kind: "none", steps: [], note: "Idempotent treff: PR-en fantes fra før, og ingenting ble endret." };
    if (created !== true || mutation.external_id === null) return { kind: "manual", steps: [], note: "Det er uklart om PR-en ble opprettet nå; undersøk i GitHub før noe lukkes." };
    return {
      kind: "compensating_action",
      steps: [{ tool_id: "github", action: "update_pr", parameters: { repo: p["repo"] ?? null, pr_number: mutation.external_id, state: "closed" } }],
      note: "Lukk den opprettede PR-en (en lukket PR kan gjenåpnes)."
    };
  }
};
