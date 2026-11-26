import type { GuardMode } from "./mode.ts";
import type { Finding } from "./scan.ts";
import type { Baseline } from "./schema.ts";

/**
 * WP-PGA / PG1 (lead-beslutning 2): «baseline kan bare krympe».
 *
 * `config/program/baseline.json` lister KJENTE brudd. Øvre grense for den er en frosset ORIGIN-liste som ligger i testkilden (ikke i datafilen): å utvide baselinen krever da en bevisst, synlig
 * endring i to filer, og den skal ikke gjøres uten en navngitt beslutning. Tre utfall:
 *  - VEKST (baseline-oppføring som ikke står i origin): rød i begge moduser;
 *  - FORELDET (oppføring uten tilsvarende funn): rød i begge moduser - et rettet brudd må fjernes fra baselinen, ellers kan et nytt brudd gjemme seg bak den;
 *  - NYTT funn (ikke i baselinen): rapportert i `report`, rødt i `enforce`.
 */
export interface BaselineResult {
  new_findings: Finding[];
  known_findings: Finding[];
  stale_entries: string[];
  growth_entries: string[];
}

export function evaluateBaseline(findings: readonly Finding[], baseline: Baseline, origin: readonly string[]): BaselineResult {
  const entryIds = new Set(baseline.entries.map((e) => e.id));
  const originSet = new Set(origin);
  const findingIds = new Set(findings.map((f) => f.id));
  return {
    new_findings: findings.filter((f) => !entryIds.has(f.id)),
    known_findings: findings.filter((f) => entryIds.has(f.id)),
    stale_entries: [...entryIds].filter((id) => !findingIds.has(id)).sort(),
    growth_entries: [...entryIds].filter((id) => !originSet.has(id)).sort()
  };
}

export interface Verdict {
  ok: boolean;
  failures: string[];
}

export function gateVerdict(mode: GuardMode, result: BaselineResult): Verdict {
  const failures: string[] = [];
  if (result.growth_entries.length > 0) failures.push(`baselinen har VOKST (ikke tillatt uten en navngitt beslutning): ${result.growth_entries.join(", ")}`);
  if (result.stale_entries.length > 0) failures.push(`foreldede baseline-oppføringer (bruddet er rettet - fjern dem): ${result.stale_entries.join(", ")}`);
  if (mode === "enforce" && result.new_findings.length > 0) failures.push(`nye funn utenfor baselinen (enforce): ${result.new_findings.map((f) => f.id).join(", ")}`);
  return { ok: failures.length === 0, failures };
}
