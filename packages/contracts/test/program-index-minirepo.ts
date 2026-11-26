import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractFingerprint, sha256Hex } from "../src/program/hash.ts";
import { ORL_IDS, PROGRAM_GATE_IDS } from "../src/program/gates.ts";
import { canonicalizeShard, serializeData } from "../src/program/index-builder.ts";
import { manifest, planned, shard, T0 } from "./program-index-fixtures.ts";

/**
 * WP-PGA: felles testhjelper - en liten, KONSISTENT repo-verden på disk (midlertidig mappe). Brukes av lasteren, registreringsverktøyet og kommandolinjen. Ikke en testfil selv.
 */
export const dirs: string[] = [];
export function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "jarvis-pga-"));
  dirs.push(d);
  return d;
}
export const put = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
};
export const json = (v: unknown): string => serializeData(v);

export const A_TS = "export const a = 1;\n";

export interface Mini {
  root: string;
  aSha: string;
}

/** En liten, KONSISTENT repo-verden på disk: to moduler, to tabeller, en tjeneste, en kontraktfil, alle porter åpne. Gir null funn. */
export function miniRepo(patchManifest: (m: ReturnType<typeof manifest>) => void = () => undefined): Mini {
  const root = tmp();
  const m = manifest();
  m.coverage = { workspace_roots: ["modules"], migrations_dir: "db", compose_file: "compose.yml", contract_roots: ["contracts"] };
  m.plans = [{ plan: "HF1", domain: "autonomy", version: "v4.0", status: "ACKNOWLEDGED_NOT_ADOPTED", decision_ref: null }];
  patchManifest(m);
  put(root, "config/program/manifest.json", json(m));
  put(root, "config/program/baseline.json", json({ schema_version: "1.0.0", entries: [] }));
  const aSha = sha256Hex(A_TS);
  const alpha = shard("core.alpha", {
    code_paths: ["modules/alpha"],
    contract: { version: "0.1.0", schema_version: "0.1.0", files: ["contracts/a.ts"], fingerprint: contractFingerprint([{ path: "contracts/a.ts", sha256: aSha }]), changed_at: T0 },
    state_store: { tables: ["t_a"], migrations: ["001_a.sql"], services: ["svc"] },
    dependencies: [{ component_id: "core.beta", min: "0.1.0", max: "0.x" }]
  });
  const beta = shard("core.beta", { code_paths: ["modules/beta"], contract: { version: "0.1.0", schema_version: "0.1.0", files: [], fingerprint: null, changed_at: T0 }, state_store: { tables: ["t_b"], migrations: ["002_b.sql"] } });
  for (const c of [alpha, beta, planned("ci.gamma")]) put(root, `config/program/components/${c.component_id}.json`, json(canonicalizeShard(c)));
  for (const id of PROGRAM_GATE_IDS) {
    put(root, `config/program/gates/${id}.json`, json({ schema_version: "1.0.0", kind: "program_gate", id, number: Number(id.slice(1)), title: `Port ${id}`, pass_criterion: "Kriterium i egne ord for testen.", bound_components: ["core.alpha"], external: false, status: "OPEN", evidence_ref: null, history: [] }));
  }
  ORL_IDS.forEach((id, level) => {
    put(root, `config/program/orl/${id}.json`, json({ schema_version: "1.0.0", kind: "orl", id, level, title: `Nivå ${level}`, exit_criterion: "Utgangskriterium i egne ord for testen.", requires_orl: level === 0 ? null : `ORL${level - 1}`, requires_gates: [], bound_components: [], external: false, status: "OPEN", evidence_ref: null, history: [] }));
  });
  put(root, "modules/alpha/package.json", json({ name: "@jarvis/alpha", dependencies: { "@jarvis/beta": "workspace:*", zod: "^3.25.76" }, devDependencies: { "@jarvis/gamma": "workspace:*" } }));
  put(root, "modules/beta/package.json", json({ name: "@jarvis/beta", dependencies: {} }));
  put(root, "db/001_a.sql", "CREATE TABLE t_a (tenant_id text, name text);\n");
  put(root, "db/002_b.sql", "CREATE TABLE t_b (tenant_id text, label text);\n");
  put(root, "compose.yml", "x-common: &common\n  restart: always\nservices:\n  svc:\n    image: x\n\nvolumes:\n  data: {}\n");
  put(root, "contracts/a.ts", A_TS);
  put(root, "docs/DECISIONS_AND_ASSUMPTIONS.md", "| D-1 | beslutning |\n| D-2 | beslutning |\n");
  return { root, aSha };
}
