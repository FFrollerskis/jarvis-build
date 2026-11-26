import { canonicalJson, sha256Hex } from "./hash.ts";
import type { Gate, Orl } from "./gates.ts";
import type { ComponentShard, Manifest } from "./schema.ts";

/**
 * WP-PGA / PG1: DETERMINISK SAMMENSLÅING av de sharda filene til én programindeks. Rekkefølgen filene leses i, og rekkefølgen av mengde-lignende lister i en skjerv (tabeller, stier, hendelser ...),
 * påvirker aldri resultatet: komponenter sorteres på id, og mengde-lister sorteres. `digest` er sha256 over den kanoniske formen: samme innhold gir samme digest på alle maskiner.
 */
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedStrings = (xs: readonly string[]): string[] => [...xs].sort(byString);

/** Skjerven med alle mengde-lignende lister sortert (notater beholder rekkefølgen). Brukes også når CLI-en skriver en skjerv tilbake. */
export function canonicalizeShard(s: ComponentShard): ComponentShard {
  return {
    ...s,
    canonical_owner: { ...s.canonical_owner, d_refs: sortedStrings(s.canonical_owner.d_refs) },
    contract: { ...s.contract, files: sortedStrings(s.contract.files) },
    code_paths: sortedStrings(s.code_paths),
    state_store: {
      tables: sortedStrings(s.state_store.tables),
      planned_tables: sortedStrings(s.state_store.planned_tables),
      runtime_tables: sortedStrings(s.state_store.runtime_tables),
      migrations: sortedStrings(s.state_store.migrations),
      services: sortedStrings(s.state_store.services),
      files: sortedStrings(s.state_store.files)
    },
    events_out: [...s.events_out].sort((a, b) => byString(a.type, b.type)),
    events_in: [...s.events_in].sort((a, b) => byString(a.type, b.type)),
    dependencies: [...s.dependencies].sort((a, b) => byString(a.component_id, b.component_id)),
    risk: { ...s.risk, memory_spaces: sortedStrings(s.risk.memory_spaces) as ComponentShard["risk"]["memory_spaces"] },
    pending_work: [...s.pending_work].sort((a, b) => byString(a.wp, b.wp)).map((w) => ({ ...w, reserved_migrations: sortedStrings(w.reserved_migrations) }))
  };
}

export interface ProgramIndex {
  format: "program-index/1";
  manifest: Manifest;
  components: ComponentShard[];
  gates: Gate[];
  orls: Orl[];
  /** sha256 (hex) over den kanoniske formen av alt over. */
  digest: string;
}

export function buildProgramIndex(manifest: Manifest, components: readonly ComponentShard[], gates: readonly Gate[], orls: readonly Orl[]): ProgramIndex {
  const ids = components.map((c) => c.component_id);
  if (new Set(ids).size !== ids.length) throw new Error("program_index_duplicate_component_id");
  const sortedComponents = components.map(canonicalizeShard).sort((a, b) => byString(a.component_id, b.component_id));
  const sortedGates = [...gates].sort((a, b) => byString(a.id, b.id));
  const sortedOrls = [...orls].sort((a, b) => byString(a.id, b.id));
  const body = { format: "program-index/1" as const, manifest, components: sortedComponents, gates: sortedGates, orls: sortedOrls };
  return { ...body, digest: sha256Hex(canonicalJson(body)) };
}

/** Ensartet serialisering av datafiler (2 blanke, avsluttende linjeskift): genereringen og `fingerprint --write` skriver identisk, så en skriving aldri gir støy i diffen. */
export function serializeData(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
