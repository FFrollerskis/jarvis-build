// @ts-expect-error ren .mjs uten typer: `renderEvidence` er den ekte evidens-skriveren (ops/acceptance/record-evidence.mjs), så testene bruker nøyaktig den toppteksten porteregistreringen leser.
import { renderEvidence } from "../../../ops/acceptance/record-evidence.mjs";

/**
 * WP-PGA fiks 1: delt testhjelper som lager evidensfiler i NØYAKTIG formen `ops/acceptance/record-evidence.mjs` skriver (samme `renderEvidence`), slik at lesingen av toppteksten (tidspunkt, git, exit,
 * stdin, merknad) testes mot den ekte skriveren og ikke bare mot en etterlignet topptekst. Ikke en testfil selv. Alt er syntetisk.
 */
export interface RealEvidenceOptions {
  /** Kommandoens exit-kode (standard 0). Ignoreres når `stdin` er satt. */
  code?: number;
  signal?: string | null;
  timedOut?: boolean;
  /** Utdata pipet inn via --stdin: opptakeren kjørte ingenting. */
  stdin?: boolean;
  /** Uren arbeidstre (true), ukjent git-status (null) eller rent (false, standard). */
  dirty?: boolean | null;
  sha?: string;
  /** ISO-tidspunktet i toppteksten (standard 2026-11-26T13:00:00.000Z, etter kontraktens changed_at i mini-repoet). */
  at?: string;
  note?: string;
  cmd?: string[];
  output?: string;
}

export const EVIDENCE_AT = "2026-11-26T13:00:00.000Z";
export const EVIDENCE_SHA = "a".repeat(40);

export function realEvidence(o: RealEvidenceOptions = {}): string {
  return renderEvidence({
    id: "fix1-test",
    note: o.note ?? "",
    cmd: o.cmd ?? ["pnpm", "test"],
    result: { code: o.stdin === true ? null : (o.code ?? 0), signal: o.signal ?? null, timedOut: o.timedOut ?? false, fromStdin: o.stdin === true, truncated: false },
    counts: {},
    info: { sha: o.sha ?? EVIDENCE_SHA, branch: "main", dirty: o.dirty === undefined ? false : o.dirty },
    now: o.at ?? EVIDENCE_AT,
    host: "testvert",
    output: o.output ?? "ok"
  }) as string;
}
