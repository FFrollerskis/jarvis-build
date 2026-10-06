import { z } from "zod";
import type { EvChangeClass } from "../constitution.ts";

/**
 * EV-7 (Evolution Masterplan v1.2 kap. 14): Supply Chain & Security Gate - avhengighetsdelen (ren funksjon). ENHVER avhengighetsendring er E2 i
 * Evolution production path. Ekstern advisory er UBETRODD evidens til primærkilde er verifisert. DEFERRED: SBOM, CodeQL, attestering/signering
 * og push-time secret protection (CI/plattform), samt faktisk malware-/registerdata for nye pakker.
 */
const PackageJsonSchema = z
  .object({
    dependencies: z.record(z.string()).optional(),
    devDependencies: z.record(z.string()).optional(),
    optionalDependencies: z.record(z.string()).optional(),
    scripts: z.record(z.string()).optional()
  })
  .passthrough();
export type PackageJsonLike = z.infer<typeof PackageJsonSchema>;

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"] as const;

/** Populære pakker en typosquat ofte etterligner (kort, bevisst liste - ikke et register). */
const POPULAR = ["react", "express", "lodash", "axios", "zod", "typescript", "vitest", "eslint", "prettier", "pg", "dotenv", "chalk", "commander", "webpack", "next", "moment", "request", "uuid", "jsonwebtoken", "bcrypt"];

export function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

const allDeps = (p: PackageJsonLike): Record<string, string> => ({ ...p.devDependencies, ...p.optionalDependencies, ...p.dependencies });

export interface Advisory {
  package: string;
  id: string;
  severity: "low" | "moderate" | "high" | "critical";
  /** Kommer fra et aggregat/feed (untrusted) eller en verifisert primærkilde. */
  source: "aggregator" | "primary";
}

export interface DependencyVerdict {
  change_class: EvChangeClass;
  changed: boolean;
  added: string[];
  removed: string[];
  version_changed: string[];
  flags: string[];
  /** Kan forslaget gå videre til eier-godkjenning? false = avvist (f.eks. typosquat-mistanke, install-script uten begrunnelse). */
  proceed_to_owner: boolean;
  advisories_needing_primary_verification: string[];
}

export function evaluateDependencyChange(beforeRaw: unknown, afterRaw: unknown, advisories: readonly Advisory[] = []): DependencyVerdict {
  const before = PackageJsonSchema.parse(beforeRaw);
  const after = PackageJsonSchema.parse(afterRaw);
  const b = allDeps(before);
  const a = allDeps(after);
  const added = Object.keys(a).filter((k) => !(k in b)).sort();
  const removed = Object.keys(b).filter((k) => !(k in a)).sort();
  const version_changed = Object.keys(a).filter((k) => k in b && b[k] !== a[k]).sort();
  const flags: string[] = [];

  for (const name of added) {
    const bare = name.replace(/^@[^/]+\//, "");
    for (const pop of POPULAR) {
      const d = editDistance(bare, pop);
      if (bare !== pop && d > 0 && d <= 1 && bare.length >= 4) flags.push(`possible_typosquat:${name}~${pop}`);
    }
    // Ikke-registerkilder omgår register-sjekker (git/url/file).
    if (/^(git|github:|https?:|file:|link:)/i.test(String(a[name]))) flags.push(`non_registry_source:${name}`);
    if (!/^[\^~]?\d|^workspace:|^npm:/.test(String(a[name])) && !flags.some((f) => f.endsWith(`:${name}`))) flags.push(`unpinned_range:${name}`);
  }
  for (const name of version_changed) if (/^(git|github:|https?:|file:|link:)/i.test(String(a[name]))) flags.push(`non_registry_source:${name}`);

  const hooksBefore = new Set(INSTALL_HOOKS.filter((h) => before.scripts?.[h] !== undefined));
  for (const h of INSTALL_HOOKS) if (after.scripts?.[h] !== undefined && (!hooksBefore.has(h) || before.scripts?.[h] !== after.scripts[h])) flags.push(`install_script_changed:${h}`);

  const changed = added.length + removed.length + version_changed.length > 0 || flags.some((f) => f.startsWith("install_script_changed"));
  const aggregatorOnly = advisories.filter((x) => x.source === "aggregator").map((x) => `${x.package}:${x.id}`);
  const suspicious = flags.some((f) => f.startsWith("possible_typosquat") || f.startsWith("non_registry_source") || f.startsWith("install_script_changed"));
  return {
    // Plan kap. 14: enhver avhengighetsendring er E2.
    change_class: changed ? "E2" : "E0",
    changed, added, removed, version_changed, flags,
    proceed_to_owner: changed && !flags.some((f) => f.startsWith("possible_typosquat")),
    advisories_needing_primary_verification: suspicious ? [...aggregatorOnly, "suspicious_flags_require_review"] : aggregatorOnly
  };
}
