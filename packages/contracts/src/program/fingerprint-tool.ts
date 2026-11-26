import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractFingerprint } from "./hash.ts";
import { loadProgramData, makeFileReader, PROGRAM_DIR } from "./fs-loader.ts";
import { canonicalizeShard, serializeData } from "./index-builder.ts";
import { ComponentShardSchema, type ComponentShard } from "./schema.ts";
import { parseSemver } from "./semver.ts";

/**
 * WP-PGA / PG1 (D-PROG-07): VERKTØYET som holder `contract.fingerprint` og `contract.changed_at` i takt med kontraktfilene. Skanningen feiler (`contract_fingerprint_mismatch`) når en kontraktfil er
 * endret uten at skjerven er oppdatert; dette verktøyet gjør oppdateringen ÉN kommando: `fingerprint <id> --write [--bump patch|minor|major]`. Uten `--write` er det en tørrkjøring (viser kun avvik).
 *
 * Den ENESTE skrivende stien i programmodulen. Skriver kun én skjerv-fil per endret komponent (atomisk: midlertidig fil + rename), validerer resultatet mot skjemaet først, og rører aldri noe
 * annet (ikke manifest, baseline, porter). `changed_at` settes til `now` KUN når fingeravtrykket faktisk endres; en `--bump` uten endring gjøres ikke (en versjon skal ikke øke uten en kontraktendring).
 */
export type BumpKind = "patch" | "minor" | "major";

export interface FingerprintChange {
  component_id: string;
  before: string | null;
  after: string | null;
  changed: boolean;
  version_before: string | null;
  version_after: string | null;
  written: boolean;
  /** Hvorfor komponenten ikke kunne oppdateres (manglende fil, ugyldig resultat ...). */
  problem: string | null;
}

export function bumpVersion(version: string, kind: BumpKind): string | null {
  const v = parseSemver(version);
  if (v === null) return null;
  if (kind === "major") return `${v.major + 1}.0.0`;
  if (kind === "minor") return `${v.major}.${v.minor + 1}.0`;
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

export interface RefreshOptions {
  /** Komponent-id-er; tom/utelatt = alle med kontraktfiler. */
  ids?: readonly string[];
  write: boolean;
  bump?: BumpKind;
  /** Tidspunkt (ISO) som settes som `changed_at` ved endring. Injiseres så testene er deterministiske. */
  now: string;
}

export function refreshFingerprints(root: string, opts: RefreshOptions): FingerprintChange[] {
  const data = loadProgramData(root);
  const reader = makeFileReader(root);
  const wanted = opts.ids !== undefined && opts.ids.length > 0 ? new Set(opts.ids) : null;
  const out: FingerprintChange[] = [];
  if (wanted !== null) {
    for (const id of wanted) {
      if (!data.components.some((c) => c.component_id === id)) {
        out.push({ component_id: id, before: null, after: null, changed: false, version_before: null, version_after: null, written: false, problem: "ukjent komponent" });
      }
    }
  }
  for (const c of data.components) {
    if (wanted !== null ? !wanted.has(c.component_id) : c.contract.files.length === 0) continue;
    const base: FingerprintChange = { component_id: c.component_id, before: c.contract.fingerprint, after: c.contract.fingerprint, changed: false, version_before: c.contract.version, version_after: c.contract.version, written: false, problem: null };
    if (c.contract.files.length === 0) {
      out.push({ ...base, problem: "komponenten har ingen kontraktfiler" });
      continue;
    }
    const hashes = c.contract.files.map((path) => ({ path, sha256: reader.file_sha256(path) }));
    const missing = hashes.filter((h) => h.sha256 === null).map((h) => h.path);
    if (missing.length > 0) {
      out.push({ ...base, problem: `kontraktfiler mangler eller kan ikke leses: ${missing.join(", ")}` });
      continue;
    }
    const after = contractFingerprint(hashes.map((h) => ({ path: h.path, sha256: h.sha256 as string })));
    const changed = after !== c.contract.fingerprint;
    let versionAfter = c.contract.version;
    if (opts.bump !== undefined && changed && c.contract.version !== null) versionAfter = bumpVersion(c.contract.version, opts.bump) ?? c.contract.version;
    const result: FingerprintChange = { ...base, after, changed, version_after: versionAfter };
    if (opts.bump !== undefined && !changed) result.problem = "ingen kontraktendring: versjonen økes ikke";
    if (opts.write && changed) {
      const next: ComponentShard = { ...c, contract: { ...c.contract, fingerprint: after, changed_at: opts.now, version: versionAfter } };
      const valid = ComponentShardSchema.safeParse(next);
      if (!valid.success) {
        out.push({ ...result, problem: "resultatet er ikke en gyldig skjerv (ikke skrevet)" });
        continue;
      }
      const file = join(root, PROGRAM_DIR, "components", `${c.component_id}.json`);
      const tmp = join(root, PROGRAM_DIR, "components", `.${c.component_id}.json.tmp-${process.pid}`);
      writeFileSync(tmp, serializeData(canonicalizeShard(valid.data)), { flag: "wx" });
      renameSync(tmp, file);
      result.written = true;
    }
    out.push(result);
  }
  return out.sort((a, b) => (a.component_id < b.component_id ? -1 : a.component_id > b.component_id ? 1 : 0));
}
