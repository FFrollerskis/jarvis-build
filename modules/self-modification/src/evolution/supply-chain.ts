import { z } from "zod";
import type { EvChangeClass } from "../constitution.ts";

/**
 * EV-7 (Evolution Masterplan v1.2 kap. 14): Supply Chain & Security Gate - avhengighetsdelen (ren funksjon). ENHVER avhengighetsendring er E2 i
 * Evolution production path. Ekstern advisory er UBETRODD evidens til primærkilde er verifisert. DEFERRED: SBOM, CodeQL, attestering/signering
 * og push-time secret protection (CI/plattform), samt faktisk malware-/registerdata for nye pakker.
 *
 * M3 (gjennomgang av PR #313): «enhver avhengighetsendring» hadde hull. Skjemaet leste bare `dependencies`/`devDependencies`/`optionalDependencies`/`scripts`, så et bytte av `pnpm.overrides`
 * (`lodash: 4.17.21` → `npm:evil@1.0.0`), `overrides`, `resolutions`, `peerDependencies` eller `bundledDependencies` ble rapportert som «Ingen avhengighetsendringer». Nå flates ALLE disse feltene ut til
 * oppføringer (seksjon + navn + spesifikasjon); en oppføring som legges til, fjernes eller endres i noen av dem er en avhengighetsendring (E2). Seksjoner holdes adskilt (en pakke flyttet fra
 * `dependencies` til `devDependencies` er en endring). Typosquat-vakten sjekker både scopet og uscopet navn, lar editeringsavstand 2 gjelde for lange navn, og løser alias (`npm:<ekte-navn>@…`) til
 * målnavnet. Kilder utenfor registeret avgjøres av en ALLOWLIST (semver/dist-tag/`workspace:`/`catalog:`/`npm:`), ikke en blokkeringsliste - alt annet (`git+https:`, URL, `file:`, `link:`,
 * `bruker/repo`-forkortelse, `gitlab:` …) er en ikke-registerkilde.
 *
 * Ikke dekket (DEFERRED/PARTIAL, sagt eksplisitt): lockfil (`pnpm-lock.yaml`), `pnpm-workspace.yaml` (kataloger/overrides) og `.npmrc` (register-oppsett) leses ikke av denne funksjonen -
 * en endring KUN der oppdages ikke. Eieren må se dem i diffen.
 */
const NamedMap = z.record(z.string());
const PackageJsonSchema = z
  .object({
    dependencies: NamedMap.optional(),
    devDependencies: NamedMap.optional(),
    optionalDependencies: NamedMap.optional(),
    peerDependencies: NamedMap.optional(),
    bundledDependencies: z.union([z.array(z.string()), z.boolean()]).optional(),
    bundleDependencies: z.union([z.array(z.string()), z.boolean()]).optional(),
    // `overrides` (npm) kan være nøstet, `resolutions` (yarn) har glob-nøkler og `pnpm` har flere underfelt: flates ut uten å anta form (se `flatten`).
    overrides: z.unknown().optional(),
    resolutions: z.unknown().optional(),
    pnpm: z.unknown().optional(),
    scripts: z.record(z.string()).optional()
  })
  .passthrough();
export type PackageJsonLike = z.infer<typeof PackageJsonSchema>;

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"] as const;

/** Populære pakker en typosquat ofte etterligner (kort, bevisst liste - ikke et register). */
const POPULAR = ["react", "express", "lodash", "axios", "zod", "typescript", "vitest", "eslint", "prettier", "pg", "dotenv", "chalk", "commander", "webpack", "next", "moment", "request", "uuid", "jsonwebtoken", "bcrypt"];

/**
 * Scope som er pakkens KJENTE scope (en pakke under dem er ikke en lookalike): `@types` er DefinitelyTyped for alle. Kort, bevisst liste - utvides ved falske positiver (en ukjent scope rundt et populært
 * navn, f.eks. `@evil/lodash`, er en lookalike og avvises).
 */
const KNOWN_SCOPES: Readonly<Record<string, readonly string[]>> = { react: ["@types", "@testing-library", "@emotion"] };
const DEFAULT_KNOWN_SCOPES: readonly string[] = ["@types"];

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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Oppføringer: alle felt som kan endre hva som installeres
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
interface DepEntry {
  section: string;
  name: string;
  spec: string;
}

/** Felt med `navn → spesifikasjon` der navnet ER pakken (typosquat-sjekkes når oppføringen er ny). */
const NAMED_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
/** pnpm-underfelt som endrer hva som installeres/kjøres. */
const PNPM_FIELDS = ["overrides", "patchedDependencies", "packageExtensions", "onlyBuiltDependencies", "neverBuiltDependencies", "ignoredBuiltDependencies"] as const;
/** Seksjoner der en NY eller ENDRET oppføring alltid krever eierens oppmerksomhet: de omskriver hva en pakke løses til (overrides/resolutions/utvidelser/patcher) eller utvider hvilke pakker som får kjøre install-skript. */
const OWNER_ATTENTION_SECTIONS: ReadonlySet<string> = new Set(["overrides", "resolutions", "pnpm.overrides", "pnpm.patchedDependencies", "pnpm.packageExtensions", "pnpm.onlyBuiltDependencies"]);
/** Seksjoner der nøkkelen er en pakkeselektor (glob-prefiks, `a>b` eller `foo@1`) som overstyres. */
const SELECTOR_SECTIONS: ReadonlySet<string> = new Set(["overrides", "resolutions", "pnpm.overrides"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Flater et vilkårlig JSON-tre til `sti → verdi` (sti skilt med `>`). Lister av strenger blir `navn → "listed"`. Dybden er begrenset så et fiendtlig tre ikke kan bruke ubegrenset tid. */
function flatten(value: unknown, path: readonly string[] = [], out: Array<[string, string]> = [], depth = 0): Array<[string, string]> {
  if (value === undefined) return out;
  if (depth > 8) { out.push([path.join(">"), "(for dypt nøstet)"]); return out; }
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      if (typeof v === "string") out.push([v, "listed"]);
      else flatten(v, [...path, String(i)], out, depth + 1);
    }
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, [...path, k], out, depth + 1);
  } else out.push([path.join(">"), String(value)]);
  return out;
}

function collectEntries(p: PackageJsonLike): Map<string, DepEntry> {
  const out = new Map<string, DepEntry>();
  const add = (section: string, name: string, spec: string): void => { out.set(`${section}\u0000${name}`, { section, name, spec }); };
  for (const section of NAMED_SECTIONS) for (const [name, spec] of Object.entries(p[section] ?? {})) add(section, name, spec);
  for (const bundled of [p.bundledDependencies, p.bundleDependencies]) {
    if (bundled === true) add("bundledDependencies", "(alle)", "bundled");
    else if (Array.isArray(bundled)) for (const name of bundled) add("bundledDependencies", name, "bundled");
  }
  for (const [name, spec] of flatten(p.overrides)) add("overrides", name, spec);
  for (const [name, spec] of flatten(p.resolutions)) add("resolutions", name, spec);
  if (isRecord(p.pnpm)) for (const field of PNPM_FIELDS) for (const [name, spec] of flatten(p.pnpm[field])) add(`pnpm.${field}`, name, spec);
  return out;
}

/** `dependencies` vises med bare navnet (som før); alle andre seksjoner med seksjonen i klammer, så en flytting mellom seksjoner er synlig. */
const display = (e: DepEntry): string => (e.section === "dependencies" ? e.name : `${e.name} [${e.section}]`);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Spesifikasjoner og navn
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
/** `npm:<ekte-navn>@<område>` (også `npm:@scope/navn@område` og `npm:navn` uten område) → målnavnet. */
export function aliasTarget(spec: string): string | null {
  const m = /^npm:((?:@[^/@\s]+\/)?[^@/\s]+)(?:@.*)?$/.exec(spec.trim());
  return m ? m[1]! : null;
}

export type SpecKind = "registry" | "alias" | "internal" | "non_registry";

/** Semver-område/versjon: starter med operatorer og så et siffer, `x` eller `*`; resten kun fra et trygt tegnsett (ingen `:`, `/`, `@` eller `#`). Dekker `1.0.0-beta.1+build`, `>=1 <2 || ^3`, `1.2.3 - 2`. */
const SEMVER_LIKE = /^[\^~<>=v\s]*(?:\d|[xX*])[\w.+*|<>=^~\s-]*$/;
/** Dist-tag (`latest`, `next`, `canary-1`). */
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * Hvor kommer pakken fra? ALLOWLIST: kun semver-område, dist-tag, `npm:`-alias, `workspace:` og `catalog:` er register/intern. ALT annet er en ikke-registerkilde: `git+https://…`, `git+ssh://…`,
 * `github:`/`gitlab:`/`bitbucket:`/`gist:`, `https://….tgz`, `file:`, `link:`, `portal:`, `patch:`, relative stier og `bruker/repo`-forkortelsen (GitHub).
 */
export function classifySpec(spec: string): SpecKind {
  const s = spec.trim();
  if (/^npm:/i.test(s)) return "alias";
  if (/^(?:workspace|catalog):/i.test(s)) return "internal";
  if (s === "" || s === "*" || SEMVER_LIKE.test(s) || DIST_TAG.test(s)) return "registry";
  return "non_registry";
}

const splitScope = (name: string): { scope: string | null; bare: string } => {
  const m = /^(@[^/]+)\/(.+)$/.exec(name);
  return m ? { scope: m[1]!, bare: m[2]! } : { scope: null, bare: name };
};

/**
 * Populære pakker et navn ligner på. Sjekker BÅDE scopet og uscopet navn: den uscopede delen sammenlignes med listen, og et scopet navn hvis uscopede del ER et populært navn er en lookalike
 * (`@evil/lodash`) med mindre scopet er pakkens kjente scope (`@types/lodash`). Nær-treff (editeringsavstand ≤ 1, eller ≤ 2 når begge navn er ≥ 6 tegn - `lodahs`) flagges uansett scope.
 */
export function lookalikes(name: string): string[] {
  const { scope, bare } = splitScope(name);
  const hits: string[] = [];
  for (const pop of POPULAR) {
    if (bare === pop) {
      if (scope !== null && !(KNOWN_SCOPES[pop] ?? DEFAULT_KNOWN_SCOPES).includes(scope)) hits.push(pop);
      continue;
    }
    if (bare.length < 4) continue;
    const limit = Math.min(bare.length, pop.length) >= 6 ? 2 : 1;
    // Lengdeforskjell > grensen betyr avstand > grensen: unngår hele DP-en for fiendtlig lange navn.
    if (Math.abs(bare.length - pop.length) <= limit && editDistance(bare, pop) <= limit) hits.push(pop);
  }
  return hits;
}

/** Pakkenavnet en overstyringsnøkkel peker på: `foo@1.2>lodash@<4.17.21` → `lodash`, glob-prefiks + `lodash` → `lodash`, `@scope/pkg@1` → `@scope/pkg`. */
function selectorPackage(key: string): string {
  const last = key.split(">").pop() ?? key;
  const noGlob = last.replace(/^(?:\*\*\/)+/, "");
  const m = /^(@[^/@]+\/[^@/]+|[^@/]+)(?:@.*)?$/.exec(noGlob);
  return m ? m[1]! : noGlob;
}

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
  /**
   * Endringen har et funn som krever eierens EKSPLISITTE oppmerksomhet (utover den vanlige E2-godkjenningen): typosquat/lookalike, ikke-registerkilde, endret install-skript, endret
   * override/resolution/patch eller alias til en annen pakke. Kommandolinjeskriptet gir exit 1 på dette (ordinære registerendringer gir exit 0 med E2-rapport).
   */
  needs_owner_review: boolean;
  advisories_needing_primary_verification: string[];
}

/** Flaggprefikser som betyr «eieren må se på dette» (alle unntatt `unpinned_range`, som bare er informasjon). */
export const OWNER_REVIEW_FLAG_PREFIXES: readonly string[] = ["possible_typosquat", "non_registry_source", "install_script_changed", "override_changed", "alias_to_other_package"];

export function evaluateDependencyChange(beforeRaw: unknown, afterRaw: unknown, advisories: readonly Advisory[] = []): DependencyVerdict {
  const before = PackageJsonSchema.parse(beforeRaw);
  const after = PackageJsonSchema.parse(afterRaw);
  const b = collectEntries(before);
  const a = collectEntries(after);
  const addedEntries = [...a].filter(([k]) => !b.has(k)).map(([, e]) => e);
  const removedEntries = [...b].filter(([k]) => !a.has(k)).map(([, e]) => e);
  const changedEntries = [...a].filter(([k, e]) => b.has(k) && b.get(k)!.spec !== e.spec).map(([, e]) => e);
  const added = addedEntries.map(display).sort();
  const removed = removedEntries.map(display).sort();
  const version_changed = changedEntries.map(display).sort();
  const flags: string[] = [];
  const flag = (f: string): void => { if (!flags.includes(f)) flags.push(f); };

  // Alt som er NYTT eller ENDRET inspiseres (en fjernet oppføring er en endring, men aldri i seg selv mistenkelig).
  const inspect = (e: DepEntry, isNew: boolean): void => {
    const label = display(e);
    if (OWNER_ATTENTION_SECTIONS.has(e.section)) flag(`override_changed:${e.section}:${e.name}`);
    if (e.spec === "bundled" || e.spec === "listed") {
      if (isNew && e.section === "bundledDependencies" && e.name !== "(alle)") for (const pop of lookalikes(e.name)) flag(`possible_typosquat:${e.name}~${pop}`);
      return;
    }
    const kind = classifySpec(e.spec);
    if (kind === "non_registry") flag(`non_registry_source:${label}`);
    const isNamed = (NAMED_SECTIONS as readonly string[]).includes(e.section);
    const keyName = isNamed ? e.name : SELECTOR_SECTIONS.has(e.section) ? selectorPackage(e.name) : null;
    const target = kind === "alias" ? aliasTarget(e.spec) : null;
    if (kind === "alias" && target === null) flag(`non_registry_source:${label}`);
    if (target !== null && keyName !== null && target !== keyName) {
      flag(`alias_to_other_package:${keyName}->${target}`);
      // Et populært navn som i virkeligheten løses til en ANNEN pakke (`zod: npm:evil-zod@1`) er selve typosquat-angrepet, bare omvendt: navnet ser trygt ut, pakken er det ikke.
      if (splitScope(keyName).scope === null && POPULAR.includes(keyName)) flag(`possible_typosquat:${keyName}~alias:${target}`);
    }
    // Navnet som FAKTISK installeres er aliasets mål (ellers nøkkelen): en ny oppføring sjekkes, og et alias (nytt eller endret) sjekkes alltid på målet.
    const effective = target ?? e.name;
    if (kind !== "internal" && (isNamed ? isNew || target !== null : target !== null)) for (const pop of lookalikes(effective)) flag(`possible_typosquat:${effective}~${pop}`);
    if (isNew && (e.section === "dependencies" || e.section === "devDependencies" || e.section === "optionalDependencies") && kind === "registry" && !/^[\^~]?\d/.test(e.spec) && !flags.some((f) => f.endsWith(`:${label}`))) flag(`unpinned_range:${label}`);
  };
  for (const e of addedEntries) inspect(e, true);
  for (const e of changedEntries) inspect(e, false);

  const hooksBefore = new Set(INSTALL_HOOKS.filter((h) => before.scripts?.[h] !== undefined));
  for (const h of INSTALL_HOOKS) if (after.scripts?.[h] !== undefined && (!hooksBefore.has(h) || before.scripts?.[h] !== after.scripts[h])) flag(`install_script_changed:${h}`);

  const changed = added.length + removed.length + version_changed.length > 0 || flags.some((f) => f.startsWith("install_script_changed"));
  const aggregatorOnly = advisories.filter((x) => x.source === "aggregator").map((x) => `${x.package}:${x.id}`);
  const review = flags.some((f) => OWNER_REVIEW_FLAG_PREFIXES.some((p) => f.startsWith(p)));
  return {
    // Plan kap. 14: enhver avhengighetsendring er E2.
    change_class: changed ? "E2" : "E0",
    changed, added, removed, version_changed, flags,
    proceed_to_owner: changed && !flags.some((f) => f.startsWith("possible_typosquat")),
    needs_owner_review: changed && review,
    advisories_needing_primary_verification: review ? [...aggregatorOnly, "suspicious_flags_require_review"] : aggregatorOnly
  };
}
