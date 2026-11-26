import { evaluateBaseline, gateVerdict, type BaselineResult, type Verdict } from "./baseline.ts";
import { BASELINE_ORIGIN } from "./baseline-origin.ts";
import { compareFindings, type Finding } from "./findings.ts";
import { collectRepoFacts, loadProgramData } from "./fs-loader.ts";
import { evaluateGate, evaluateOrl, makeGateContext, scanGates } from "./gates.ts";
import type { GateStatus } from "./gate-events.ts";
import { buildProgramIndex, type ProgramIndex } from "./index-builder.ts";
import { GUARD_MODE_ENV, resolveGuardMode, type ResolvedGuardMode } from "./mode.ts";
import { scanProgramIndex } from "./scan.ts";

/**
 * WP-PGA / PG1+PG3: ORKESTRATOREN. Laster dataene, samler repo-fakta, kjører skanningen og port-skanningen, bygger den sammenslåtte indeksen og avgjør utfallet etter modus og baseline.
 * Brukes av repo-testen og CLI-en (`scripts/program-index.ts`); begge får dermed nøyaktig samme dom. Ren lesing: ingen skriving, ingen nettverk.
 */
export interface StatusCounts {
  OPEN: number;
  PASS: number;
  FAIL: number;
}

export interface ProgramCounts {
  components_total: number;
  components_built: number;
  components_planned: number;
  tables_total: number;
  tables_owned: number;
  workspace_dirs: number;
  workspace_dirs_covered: number;
  migrations_total: number;
  migrations_claimed: number;
  services_total: number;
  services_owned: number;
  event_types: number;
  gates_declared: StatusCounts;
  gates_effective: StatusCounts;
  orls_declared: StatusCounts;
  orls_effective: StatusCounts;
}

export interface ProgramRun {
  mode: ResolvedGuardMode;
  index: ProgramIndex;
  /** Alle funn (lasting + skanning + porter), sortert og unike. */
  findings: Finding[];
  baseline: BaselineResult;
  verdict: Verdict;
  counts: ProgramCounts;
}

export interface RunOptions {
  root: string;
  /** Verdien av PROGRAM_INDEX_MODE (eller undefined). */
  env: string | undefined;
  /** Øvre grense for baselinen; standard er den frosne `BASELINE_ORIGIN`. Kun testene overstyrer den. */
  origin?: readonly string[];
}

const zero = (): StatusCounts => ({ OPEN: 0, PASS: 0, FAIL: 0 });

export function runProgramIndex(opts: RunOptions): ProgramRun {
  const data = loadProgramData(opts.root);
  const mode = resolveGuardMode(data.manifest.guard.mode, opts.env);
  const repo = collectRepoFacts(opts.root, data.manifest);
  const scan = scanProgramIndex({ manifest: data.manifest, components: data.components, repo });
  const ctx = makeGateContext(data.components, repo.file_sha256);
  const gateFindings = scanGates({ gates: data.gates, orls: data.orls, component_ids: new Set(data.components.map((c) => c.component_id)), ctx });

  const all = new Map<string, Finding>();
  for (const f of [...data.findings, ...scan, ...gateFindings]) if (!all.has(f.id)) all.set(f.id, f);
  const findings = [...all.values()].sort(compareFindings);

  const baseline = evaluateBaseline(findings, data.baseline, opts.origin ?? BASELINE_ORIGIN);
  const verdict = gateVerdict(mode.mode, baseline);

  // Tellinger (for rapporten): tabeller/kataloger/migrasjoner/tjenester med eier, og effektiv status for porter/nivåer.
  const owned = <T>(items: Iterable<T>, claimed: Set<T>): number => [...items].filter((i) => claimed.has(i)).length;
  const tableOwnerCount = new Map<string, number>();
  for (const c of data.components) for (const t of c.state_store.tables) tableOwnerCount.set(t, (tableOwnerCount.get(t) ?? 0) + 1);
  const claimedMigrations = new Set(data.components.flatMap((c) => c.state_store.migrations));
  const claimedServices = new Set(data.components.flatMap((c) => c.state_store.services));
  const covered = repo.workspace_dirs.filter((d) => data.components.some((c) => c.code_paths.some((p) => d === p || d.startsWith(`${p}/`))));
  const effectiveGate = new Map<string, GateStatus>();
  const gatesEffective = zero();
  const gatesDeclared = zero();
  for (const g of data.gates) {
    const e = evaluateGate(g, ctx);
    effectiveGate.set(g.id, e.effective);
    gatesDeclared[e.declared] += 1;
    gatesEffective[e.effective] += 1;
  }
  const effectiveOrl = new Map<string, GateStatus>();
  const orlsEffective = zero();
  const orlsDeclared = zero();
  for (const o of [...data.orls].sort((a, b) => a.level - b.level)) {
    const e = evaluateOrl(o, ctx, (id) => effectiveGate.get(id) ?? "OPEN", (id) => effectiveOrl.get(id) ?? "OPEN");
    effectiveOrl.set(o.id, e.effective);
    orlsDeclared[e.declared] += 1;
    orlsEffective[e.effective] += 1;
  }
  const counts: ProgramCounts = {
    components_total: data.components.length,
    components_built: data.components.filter((c) => c.runtime_state !== "planned").length,
    components_planned: data.components.filter((c) => c.runtime_state === "planned").length,
    tables_total: repo.tables.size,
    tables_owned: [...repo.tables.keys()].filter((t) => tableOwnerCount.get(t) === 1).length,
    workspace_dirs: repo.workspace_dirs.length,
    workspace_dirs_covered: covered.length,
    migrations_total: repo.migration_files.length,
    migrations_claimed: owned(repo.migration_files, claimedMigrations),
    services_total: repo.compose_services.length,
    services_owned: owned(repo.compose_services, claimedServices),
    event_types: new Set(data.components.flatMap((c) => c.events_out.map((e) => e.type))).size,
    gates_declared: gatesDeclared,
    gates_effective: gatesEffective,
    orls_declared: orlsDeclared,
    orls_effective: orlsEffective
  };
  return { mode, index: buildProgramIndex(data.manifest, data.components, data.gates, data.orls), findings, baseline, verdict, counts };
}

/** Lesbar rapport (norsk). Rent tekstuttrekk av `ProgramRun`: samme tall som `--json`. */
export function formatReport(run: ProgramRun, maxFindings = 60): string {
  const c = run.counts;
  const lines: string[] = [];
  lines.push(`Programindeks ${run.index.digest.slice(0, 12)}: ${c.components_total} komponenter (${c.components_built} bygd, ${c.components_planned} planlagt)`);
  lines.push(`Eierskap: ${c.tables_owned}/${c.tables_total} tabeller, ${c.workspace_dirs_covered}/${c.workspace_dirs} kataloger, ${c.migrations_claimed}/${c.migrations_total} migrasjoner, ${c.services_owned}/${c.services_total} compose-tjenester, ${c.event_types} hendelsestyper`);
  lines.push(`Modus: ${run.mode.mode} (manifest: ${run.mode.manifest_mode}; ${GUARD_MODE_ENV}: ${run.mode.env_mode ?? "ikke satt"}${run.mode.raised_by_env ? "; hevet av miljøet" : ""})`);
  lines.push(`Porter: ${c.gates_effective.PASS} PASS, ${c.gates_effective.OPEN} OPEN, ${c.gates_effective.FAIL} FAIL (deklarert PASS: ${c.gates_declared.PASS}); ORL: ${c.orls_effective.PASS} av ${c.orls_effective.PASS + c.orls_effective.OPEN + c.orls_effective.FAIL} PASS`);
  lines.push(`Funn: ${run.findings.length} (${run.baseline.new_findings.length} nye, ${run.baseline.known_findings.length} kjent i baselinen); baseline: ${run.baseline.stale_entries.length} foreldet, ${run.baseline.growth_entries.length} vekst`);
  const byRule = new Map<string, number>();
  for (const f of run.findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
  for (const [rule, n] of [...byRule].sort()) lines.push(`  ${rule}: ${n}`);
  for (const f of run.findings.slice(0, maxFindings)) lines.push(`  - ${f.id}: ${f.message}`);
  if (run.findings.length > maxFindings) lines.push(`  ... og ${run.findings.length - maxFindings} til (bruk --json)`);
  lines.push(run.verdict.ok ? "Dom: OK" : `Dom: RØD - ${run.verdict.failures.join(" | ")}`);
  if (run.mode.mode === "report" && run.baseline.new_findings.length > 0) lines.push("(report-modus: nye funn feiler ikke bygget; sett guard.mode til enforce i config/program/manifest.json for å håndheve)");
  return lines.join("\n");
}
